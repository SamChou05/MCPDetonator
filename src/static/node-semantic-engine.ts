import { posix } from "node:path";

import ts from "typescript-semantic";

import { sha256 } from "../evidence-store.js";
import type { StaticEvidenceReferenceV1 } from "./contracts.js";
import {
  NODE_SEMANTIC_CATALOG_VERSION,
  findNodeSemanticSink,
  type NodeSemanticSink,
  type SemanticOperation,
} from "./node-semantic-catalog.js";
import {
  nodeSemanticStaticV1Schema,
  type NodeSemanticLimitsV1,
  type NodeSemanticStaticV1,
} from "./semantic-contracts.js";

const virtualRoot = "/forge-target";
const maxIssues = 1_024;

export interface NodeSemanticSourceInput {
  readonly targetPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly evidence: StaticEvidenceReferenceV1;
  readonly content: string;
}

export interface NodeSemanticEngineInput {
  readonly runId: string;
  readonly targetId: string;
  readonly generatedAt: string;
  readonly lexicalInspectionArtifact: string;
  readonly lexicalInspectionSha256: string;
  readonly sourceSetSha256: string;
  readonly limits: NodeSemanticLimitsV1;
  readonly sources: readonly NodeSemanticSourceInput[];
}

type SemanticCallsite = NodeSemanticStaticV1["callsites"][number];
type SemanticIssue = NodeSemanticStaticV1["issues"][number];
type SemanticTruncation = NodeSemanticStaticV1["truncations"][number];

interface ModuleOrigin {
  readonly kind: "module";
  readonly module: string;
  readonly depth: number;
  readonly resolution: SemanticCallsite["resolution"];
  readonly defaultIsModule?: boolean;
}

interface MemberOrigin {
  readonly kind: "member";
  readonly module: string;
  readonly member: string;
  readonly depth: number;
  readonly resolution: SemanticCallsite["resolution"];
}

type Origin = ModuleOrigin | MemberOrigin;

function moduleMemberOrigin(base: ModuleOrigin, member: string): Origin {
  if (
    member === "promises" &&
    (base.module === "fs" || base.module === "dns")
  ) {
    return {
      ...base,
      module: `${base.module}/promises`,
      defaultIsModule: false,
    };
  }
  if (member === "default" && base.defaultIsModule === true) return base;
  if (base.module === "global" && member === "process") {
    return { ...base, module: "process" };
  }
  return {
    kind: "member",
    module: base.module,
    member,
    depth: base.depth,
    resolution: base.resolution,
  };
}

const builtinModules = new Set([
  "child_process",
  "dns",
  "dns/promises",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "net",
  "process",
  "tls",
  "vm",
]);

const modeledSyntaxGlobals = new Set([
  "Function",
  "WebSocket",
  "eval",
  "fetch",
  "globalThis",
  "process",
  "require",
]);

const sourceExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeBuiltin(specifier: string): string | undefined {
  const withoutPrefix = specifier.startsWith("node:")
    ? specifier.slice("node:".length)
    : specifier;
  return builtinModules.has(withoutPrefix) ? withoutPrefix : undefined;
}

function literalText(expression: ts.Expression | undefined): string | undefined {
  return expression !== undefined &&
    (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function staticMemberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    return literalText(node.argumentExpression);
  }
  return undefined;
}

function unwrapExpressionDetails(expression: ts.Expression): {
  readonly expression: ts.Expression;
  readonly awaited: boolean;
} {
  let current = expression;
  let awaited = false;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    if (ts.isAwaitExpression(current)) awaited = true;
    current = current.expression;
  }
  return { expression: current, awaited };
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  return unwrapExpressionDetails(expression).expression;
}

function transparentParent(node: ts.Expression): ts.Expression | undefined {
  const parent = node.parent;
  return (ts.isParenthesizedExpression(parent) ||
    ts.isAsExpression(parent) ||
    ts.isTypeAssertionExpression(parent) ||
    ts.isNonNullExpression(parent) ||
    ts.isSatisfiesExpression(parent)) &&
    parent.expression === node
    ? parent
    : undefined;
}

function isDirectlyAwaited(expression: ts.Expression): boolean {
  let current = expression;
  let parent = transparentParent(current);
  while (parent !== undefined) {
    current = parent;
    parent = transparentParent(current);
  }
  return (
    ts.isAwaitExpression(current.parent) && current.parent.expression === current
  );
}

function expressionResultIsDiscarded(expression: ts.Expression): boolean {
  let current = expression;
  let parent = transparentParent(current);
  while (parent !== undefined) {
    current = parent;
    parent = transparentParent(current);
  }
  return (
    ts.isExpressionStatement(current.parent) ||
    (ts.isVoidExpression(current.parent) && current.parent.expression === current)
  );
}

function assignmentRoot(node: ts.Expression): ts.Identifier | undefined {
  const current = unwrapExpression(node);
  if (ts.isIdentifier(current)) return current;
  if (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    return assignmentRoot(current.expression);
  }
  return undefined;
}

function firstStaticMemberFromRoot(
  node: ts.Expression,
  rootName: string,
): string | undefined {
  const current = unwrapExpression(node);
  if (
    !ts.isPropertyAccessExpression(current) &&
    !ts.isElementAccessExpression(current)
  ) {
    return undefined;
  }
  const base = unwrapExpression(current.expression);
  if (ts.isIdentifier(base) && base.text === rootName) {
    return staticMemberName(current);
  }
  return firstStaticMemberFromRoot(current.expression, rootName);
}

function purelyTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  return (
    clause?.isTypeOnly === true ||
    (clause !== undefined &&
      clause.name === undefined &&
      clause.namedBindings !== undefined &&
      ts.isNamedImports(clause.namedBindings) &&
      clause.namedBindings.elements.length > 0 &&
      clause.namedBindings.elements.every((element) => element.isTypeOnly))
  );
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function virtualPath(targetPath: string): string {
  return `${virtualRoot}/${targetPath}`;
}

function targetPathFromVirtual(path: string): string | undefined {
  const prefix = `${virtualRoot}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}

function resolveRelativeTarget(
  importer: string,
  specifier: string,
  admittedPaths: ReadonlySet<string>,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) {
    return undefined;
  }
  const emittedExtensionCandidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`]
    : base.endsWith(".mjs")
      ? [`${base.slice(0, -4)}.mts`]
      : base.endsWith(".cjs")
        ? [`${base.slice(0, -4)}.cts`]
        : base.endsWith(".jsx")
          ? [`${base.slice(0, -4)}.tsx`]
          : [];
  const candidates = [
    base,
    ...emittedExtensionCandidates,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => admittedPaths.has(candidate));
}

function isUnshadowedGlobal(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  return (
    symbol === undefined ||
    symbol.declarations === undefined ||
    symbol.declarations.every(
      (declaration) => !declarationCreatesRuntimeBinding(declaration),
    )
  );
}

function declarationCreatesRuntimeBinding(declaration: ts.Declaration): boolean {
  if (declaration.getSourceFile().isDeclarationFile) return false;
  // With no default library, the checker can synthesize declarations from
  // assignment targets. Those are mutations of an unresolved global, not
  // lexical declarations that shadow it.
  if (
    ts.isIdentifier(declaration) ||
    ts.isPropertyAccessExpression(declaration) ||
    ts.isElementAccessExpression(declaration)
  ) {
    return false;
  }
  let current: ts.Node | undefined = declaration;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (
      ts.canHaveModifiers(current) &&
      ts.getModifiers(current)?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword,
      ) === true
    ) {
      return false;
    }
    current = current.parent;
  }
  if (ts.isImportSpecifier(declaration) && declaration.isTypeOnly) return false;
  let ancestor: ts.Node | undefined = declaration.parent;
  while (ancestor !== undefined && !ts.isSourceFile(ancestor)) {
    if (ts.isImportClause(ancestor)) return !ancestor.isTypeOnly;
    ancestor = ancestor.parent;
  }
  return true;
}

function isConstVariableDeclaration(
  declaration: ts.VariableDeclaration,
): boolean {
  return (
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
  );
}

function isDeclarationIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier) ||
    (ts.isImportClause(parent) && parent.name === identifier) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isImportEqualsDeclaration(parent) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    ((ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent)) &&
      parent.name === identifier) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier)
  );
}

function callsiteId(options: {
  readonly source: NodeSemanticSourceInput;
  readonly node: ts.Node;
  readonly sink: NodeSemanticSink;
}): string {
  return `semantic-callsite-${sha256(
    [
      "forge.node-semantic-callsite/v1",
      options.source.targetPath,
      options.source.sha256,
      String(options.node.getStart()),
      String(options.node.getEnd()),
      options.sink.sinkId,
      options.sink.operation,
      options.sink.capability,
    ].join("\0"),
  ).slice(0, 32)}`;
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts
    .flattenDiagnosticMessageText(diagnostic.messageText, " ")
    .replaceAll(virtualRoot, "<target>")
    .slice(0, 512);
}

function sourceExcerpt(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = node
    .getText(sourceFile)
    .replace(/\s+/gu, " ")
    .trim();
  return text.slice(0, 240) || "<empty callsite>";
}

export function analyzeNodeSemanticSources(
  input: NodeSemanticEngineInput,
): NodeSemanticStaticV1 {
  const sources = [...input.sources].sort((left, right) =>
    compareText(left.targetPath, right.targetPath),
  );
  const sourceByVirtualPath = new Map(
    sources.map((source) => [virtualPath(source.targetPath), source]),
  );
  const sourceByTargetPath = new Map(
    sources.map((source) => [source.targetPath, source]),
  );
  const admittedPaths = new Set(sourceByTargetPath.keys());
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext,
    moduleDetection: ts.ModuleDetectionKind.Force,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host: ts.CompilerHost = {
    fileExists: (path) => sourceByVirtualPath.has(path),
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => virtualRoot,
    getDefaultLibFileName: () => "/__forge_no_lib__.d.ts",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (path, languageVersion) => {
      const source = sourceByVirtualPath.get(path);
      return source === undefined
        ? undefined
        : ts.createSourceFile(
            path,
            source.content,
            languageVersion,
            true,
            scriptKind(path),
          );
    },
    readFile: (path) => sourceByVirtualPath.get(path)?.content,
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined,
  };

  const program = ts.createProgram({
    rootNames: [...sourceByVirtualPath.keys()],
    options: compilerOptions,
    host,
  });
  const checker = program.getTypeChecker();
  const sourceFiles = program
    .getSourceFiles()
    .filter((sourceFile) => targetPathFromVirtual(sourceFile.fileName) !== undefined)
    .sort((left, right) => compareText(left.fileName, right.fileName));
  const truncations = new Set<SemanticTruncation>();
  const issues: SemanticIssue[] = [];
  let resolutionIncomplete = false;

  function addIssue(issue: SemanticIssue): void {
    if (issues.length >= maxIssues) {
      truncations.add("issues");
      resolutionIncomplete = true;
      return;
    }
    issues.push(issue);
  }

  let diagnosticsRetained = 0;
  const files: NodeSemanticStaticV1["files"] = [];
  for (const sourceFile of sourceFiles) {
    const targetPath = targetPathFromVirtual(sourceFile.fileName);
    const source =
      targetPath === undefined ? undefined : sourceByTargetPath.get(targetPath);
    if (source === undefined || targetPath === undefined) continue;
    const syntaxDiagnostics = program.getSyntacticDiagnostics(sourceFile);
    const remainingDiagnostics = Math.max(
      0,
      input.limits.maxDiagnostics - diagnosticsRetained,
    );
    const retained = syntaxDiagnostics.slice(0, remainingDiagnostics);
    diagnosticsRetained += retained.length;
    if (retained.length < syntaxDiagnostics.length) {
      truncations.add("diagnostics");
      resolutionIncomplete = true;
    }
    files.push({
      targetPath,
      sizeBytes: source.sizeBytes,
      sha256: source.sha256,
      evidence: source.evidence,
      parseStatus:
        syntaxDiagnostics.length === 0 ? "parsed" : "syntax_errors",
      syntaxDiagnosticCount: syntaxDiagnostics.length,
      diagnostics: retained.map((diagnostic) => {
        const position =
          diagnostic.start === undefined
            ? undefined
            : sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
        return {
          code: diagnostic.code,
          ...(position === undefined
            ? {}
            : { line: position.line + 1, column: position.character + 1 }),
          message: diagnosticMessage(diagnostic),
        };
      }),
      diagnosticsTruncated: retained.length < syntaxDiagnostics.length,
    });
  }

  const nodes: ts.Node[] = [];
  let astNodesVisited = 0;
  let callExpressionsVisited = 0;
  for (const [fileIndex, sourceFile] of sourceFiles.entries()) {
    const stack: ts.Node[] = [sourceFile];
    while (stack.length > 0 && astNodesVisited < input.limits.maxAstNodes) {
      const node = stack.pop();
      if (node === undefined) break;
      nodes.push(node);
      astNodesVisited += 1;
      if (ts.isCallExpression(node)) callExpressionsVisited += 1;
      const children: ts.Node[] = [];
      node.forEachChild((child) => {
        children.push(child);
      });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) stack.push(child);
      }
    }
    if (
      stack.length > 0 ||
      (astNodesVisited >= input.limits.maxAstNodes &&
        fileIndex + 1 < sourceFiles.length)
    ) {
      truncations.add("ast_nodes");
      resolutionIncomplete = true;
      break;
    }
  }

  const taintedSymbols = new Set<ts.Symbol>();
  const directGlobalMutations = new Map<
    string,
    { readonly identifier: ts.Identifier; readonly name: string }
  >();
  function globalMutationKey(sourceFile: ts.SourceFile, name: string): string {
    return `${sourceFile.fileName}\0${name}`;
  }
  function recordGlobalMutation(identifier: ts.Identifier, name: string): void {
    directGlobalMutations.set(
      globalMutationKey(identifier.getSourceFile(), name),
      { identifier, name },
    );
  }
  for (const node of nodes) {
    let mutated: ts.Expression | undefined;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      mutated = node.left;
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      mutated = node.operand;
    } else if (ts.isDeleteExpression(node)) {
      mutated = node.expression;
    }
    if (mutated === undefined) continue;
    const root = assignmentRoot(mutated);
    if (root === undefined) continue;
    const symbol = checker.getSymbolAtLocation(root);
    if (
      modeledSyntaxGlobals.has(root.text) &&
      isUnshadowedGlobal(root, checker)
    ) {
      recordGlobalMutation(root, root.text);
      const unwrappedMutation = unwrapExpression(mutated);
      if (
        root.text === "globalThis" &&
        (ts.isPropertyAccessExpression(unwrappedMutation) ||
          ts.isElementAccessExpression(unwrappedMutation))
      ) {
        const member = firstStaticMemberFromRoot(mutated, "globalThis");
        const affectedNames =
          member === undefined
            ? [...modeledSyntaxGlobals]
            : modeledSyntaxGlobals.has(member)
              ? [member]
              : [];
        for (const name of affectedNames) recordGlobalMutation(root, name);
      }
    }
    if (symbol !== undefined) {
      taintedSymbols.add(symbol);
    }
  }

  function isAvailableGlobal(identifier: ts.Identifier): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    return (
      isUnshadowedGlobal(identifier, checker) &&
      (symbol === undefined || !taintedSymbols.has(symbol)) &&
      !directGlobalMutations.has(
        globalMutationKey(identifier.getSourceFile(), identifier.text),
      )
    );
  }

  for (const { identifier, name } of directGlobalMutations.values()) {
    resolutionIncomplete = true;
    const targetPath = targetPathFromVirtual(
      identifier.getSourceFile().fileName,
    );
    addIssue({
      kind: "unsupported_binding_flow",
      ...(targetPath === undefined ? {} : { targetPath }),
      summary: `The modeled global '${name}' is directly mutation-affected in this source file; global resolution is withheld regardless of source order.`,
    });
  }

  for (const node of nodes) {
    if (!ts.isCallExpression(node)) continue;
    const callee = unwrapExpression(node.expression);
    if (callee.kind !== ts.SyntaxKind.ImportKeyword) continue;
    const module = normalizeBuiltin(literalText(node.arguments[0]) ?? "");
    if (
      module === undefined ||
      isDirectlyAwaited(node) ||
      expressionResultIsDiscarded(node)
    ) {
      continue;
    }
    resolutionIncomplete = true;
    const targetPath = targetPathFromVirtual(node.getSourceFile().fileName);
    addIssue({
      kind: "unsupported_binding_flow",
      ...(targetPath === undefined ? {} : { targetPath }),
      summary: `Promise-based binding flow from import('${module}') is not followed; directly await the import to enable namespace resolution.`,
    });
  }

  let moduleResolutionsAttempted = 0;
  let moduleResolutionsUnresolved = 0;
  for (const node of nodes) {
    let specifier: string | undefined;
    let carriesBindings = false;
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (purelyTypeOnlyImport(node)) continue;
      const runtimeBinding =
        clause !== undefined &&
        (clause.name !== undefined ||
          (clause.namedBindings !== undefined &&
            (ts.isNamespaceImport(clause.namedBindings) ||
              clause.namedBindings.elements.some(
                (element) => !element.isTypeOnly,
              ))));
      specifier = node.moduleSpecifier.text;
      carriesBindings = runtimeBinding;
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
      carriesBindings = true;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      specifier = literalText(node.moduleReference.expression);
      carriesBindings = true;
    } else if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        isAvailableGlobal(callee)
      ) {
        specifier = literalText(node.arguments[0]);
        carriesBindings = true;
      } else if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = literalText(node.arguments[0]);
        carriesBindings = true;
      }
    }
    if (specifier === undefined || !specifier.startsWith(".")) continue;
    if (moduleResolutionsAttempted >= input.limits.maxModuleResolutions) {
      truncations.add("module_resolutions");
      resolutionIncomplete = true;
      break;
    }
    const sourceFile = node.getSourceFile();
    const importer = targetPathFromVirtual(sourceFile.fileName);
    if (importer === undefined) continue;
    moduleResolutionsAttempted += 1;
    if (resolveRelativeTarget(importer, specifier, admittedPaths) === undefined) {
      moduleResolutionsUnresolved += 1;
      resolutionIncomplete = true;
      addIssue({
        kind: "unresolved_relative_module",
        targetPath: importer,
        summary: `Relative module '${specifier.slice(0, 200)}' was not present in the admitted source set.`,
      });
    } else if (carriesBindings) {
      resolutionIncomplete = true;
      addIssue({
        kind: "unsupported_binding_flow",
        targetPath: importer,
        summary: `Cross-file binding flow through '${specifier.slice(0, 200)}' is admitted but not followed by this analyzer version.`,
      });
    }
  }
  for (const sourceFile of sourceFiles) {
    if (sourceFile.referencedFiles.length === 0) continue;
    resolutionIncomplete = true;
    const targetPath = targetPathFromVirtual(sourceFile.fileName);
    if (targetPath !== undefined) {
      addIssue({
        kind: "unresolved_relative_module",
        targetPath,
        summary:
          "Triple-slash references are intentionally not resolved by the closed semantic host.",
      });
    }
  }

  const origins = new Map<ts.Symbol, Origin>();

  // A mutation through an immutable namespace/member alias also invalidates
  // the original namespace. Propagate that taint over const identifier and
  // destructured aliases in bounded linear graph work.
  const aliasNeighbors = new Map<ts.Symbol, Set<ts.Symbol>>();
  function connectAlias(left: ts.Symbol, right: ts.Symbol): void {
    const leftNeighbors = aliasNeighbors.get(left) ?? new Set<ts.Symbol>();
    leftNeighbors.add(right);
    aliasNeighbors.set(left, leftNeighbors);
    const rightNeighbors = aliasNeighbors.get(right) ?? new Set<ts.Symbol>();
    rightNeighbors.add(left);
    aliasNeighbors.set(right, rightNeighbors);
  }
  for (const node of nodes) {
    if (
      !ts.isVariableDeclaration(node) ||
      !isConstVariableDeclaration(node) ||
      node.initializer === undefined
    ) {
      continue;
    }
    const referencedIdentifier = assignmentRoot(node.initializer);
    if (referencedIdentifier === undefined) continue;
    const referenced = checker.getSymbolAtLocation(referencedIdentifier);
    if (referenced === undefined) continue;
    for (const identifier of bindingIdentifiers(node.name)) {
      const declared = checker.getSymbolAtLocation(identifier);
      if (declared !== undefined) connectAlias(declared, referenced);
    }
  }
  const taintQueue = [...taintedSymbols];
  for (let index = 0; index < taintQueue.length; index += 1) {
    const symbol = taintQueue[index];
    if (symbol === undefined) continue;
    for (const neighbor of aliasNeighbors.get(symbol) ?? []) {
      if (taintedSymbols.has(neighbor)) continue;
      taintedSymbols.add(neighbor);
      taintQueue.push(neighbor);
    }
  }

  function bind(identifier: ts.Identifier, origin: Origin): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    if (
      symbol === undefined ||
      taintedSymbols.has(symbol) ||
      origins.has(symbol)
    ) {
      return false;
    }
    origins.set(symbol, origin);
    return true;
  }

  function resolveOrigin(expression: ts.Expression): Origin | undefined {
    const unwrapped = unwrapExpressionDetails(expression);
    const current = unwrapped.expression;
    if (ts.isIdentifier(current)) {
      const symbol = checker.getSymbolAtLocation(current);
      const bound =
        symbol === undefined || taintedSymbols.has(symbol)
          ? undefined
          : origins.get(symbol);
      if (bound !== undefined) return bound;
      if (
        (current.text === "process" || current.text === "globalThis") &&
        isAvailableGlobal(current)
      ) {
        return {
          kind: "module",
          module: current.text === "process" ? "process" : "global",
          depth: 0,
          resolution: "syntax_resolved",
        };
      }
      if (current.text === "require" && isAvailableGlobal(current)) {
        return {
          kind: "member",
          module: "global",
          member: "require",
          depth: 0,
          resolution: "syntax_resolved",
        };
      }
      if (
        isAvailableGlobal(current) &&
        (findNodeSemanticSink({
          module: "global",
          member: current.text,
          operation: "call",
        }) !== undefined ||
          findNodeSemanticSink({
            module: "global",
            member: current.text,
            operation: "construct",
          }) !== undefined)
      ) {
        return {
          kind: "member",
          module: "global",
          member: current.text,
          depth: 0,
          resolution: "syntax_resolved",
        };
      }
      return undefined;
    }
    if (
      ts.isCallExpression(current) &&
      current.expression.kind === ts.SyntaxKind.ImportKeyword &&
      unwrapped.awaited
    ) {
      const module = normalizeBuiltin(literalText(current.arguments[0]) ?? "");
      return module === undefined
        ? undefined
        : {
            kind: "module",
            module,
            depth: 0,
            resolution: "syntax_resolved",
            defaultIsModule: true,
          };
    }
    if (ts.isCallExpression(current)) {
      const loader = resolveOrigin(current.expression);
      if (
        loader?.kind === "member" &&
        loader.module === "global" &&
        loader.member === "require"
      ) {
        const module = normalizeBuiltin(literalText(current.arguments[0]) ?? "");
        if (module !== undefined) {
          return {
            kind: "module",
            module,
            depth: loader.depth,
            resolution: loader.resolution,
          };
        }
      }
    }
    const callCallee = ts.isCallExpression(current)
      ? unwrapExpression(current.expression)
      : undefined;
    if (
      ts.isCallExpression(current) &&
      callCallee !== undefined &&
      ts.isIdentifier(callCallee) &&
      callCallee.text === "require" &&
      isAvailableGlobal(callCallee)
    ) {
      const module = normalizeBuiltin(literalText(current.arguments[0]) ?? "");
      return module === undefined
        ? undefined
        : {
            kind: "module",
            module,
            depth: 0,
            resolution: "syntax_resolved",
          };
    }
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current)
    ) {
      const base = resolveOrigin(current.expression);
      const member = staticMemberName(current);
      if (base === undefined || member === undefined || base.kind !== "module") {
        return undefined;
      }
      return moduleMemberOrigin(base, member);
    }
    return undefined;
  }

  function discloseTaintedImport(node: ts.Node, tainted: boolean): void {
    if (!tainted) return;
    resolutionIncomplete = true;
    const targetPath = targetPathFromVirtual(node.getSourceFile().fileName);
    addIssue({
      kind: "unsupported_binding_flow",
      ...(targetPath === undefined ? {} : { targetPath }),
      summary:
        "A modeled built-in import is affected by mutation through its binding or an immutable alias; callsites through that origin are withheld.",
    });
  }

  function importedBindingIsTainted(identifier: ts.Identifier): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    return symbol !== undefined && taintedSymbols.has(symbol);
  }

  for (const node of nodes) {
    if (ts.isImportEqualsDeclaration(node)) {
      if (
        node.isTypeOnly ||
        !ts.isExternalModuleReference(node.moduleReference)
      ) {
        continue;
      }
      const module = normalizeBuiltin(
        literalText(node.moduleReference.expression) ?? "",
      );
      if (module === undefined) continue;
      const taintedImport = importedBindingIsTainted(node.name);
      if (!taintedImport) {
        bind(node.name, {
          kind: "module",
          module,
          depth: 0,
          resolution: "symbol_resolved",
        });
      }
      discloseTaintedImport(node, taintedImport);
      continue;
    }
    if (!ts.isImportDeclaration(node) || node.importClause === undefined) continue;
    if (
      node.importClause.isTypeOnly ||
      !ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      continue;
    }
    const module = normalizeBuiltin(node.moduleSpecifier.text);
    if (module === undefined) continue;
    const directModule: ModuleOrigin = {
      kind: "module",
      module,
      depth: 0,
      resolution: "symbol_resolved",
      defaultIsModule: true,
    };
    const importedBindings: Array<{
      readonly identifier: ts.Identifier;
      readonly origin: Origin;
    }> = [];
    if (node.importClause.name !== undefined) {
      importedBindings.push({
        identifier: node.importClause.name,
        origin: directModule,
      });
    }
    const bindings = node.importClause.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      importedBindings.push({ identifier: bindings.name, origin: directModule });
    } else if (bindings !== undefined) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) continue;
        importedBindings.push({
          identifier: element.name,
          origin: moduleMemberOrigin(
            directModule,
            (element.propertyName ?? element.name).text,
          ),
        });
      }
    }
    const taintedImport = importedBindings.some(({ identifier }) =>
      importedBindingIsTainted(identifier),
    );
    if (!taintedImport) {
      for (const imported of importedBindings) {
        bind(imported.identifier, imported.origin);
      }
    }
    discloseTaintedImport(node, taintedImport);
  }

  const immutableDeclarations = nodes.filter(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      isConstVariableDeclaration(node) &&
      node.initializer !== undefined,
  );

  function bindDeclaration(declaration: ts.VariableDeclaration): boolean {
    const initializer = declaration.initializer;
    if (initializer === undefined) return false;
    const origin = resolveOrigin(initializer);
    if (origin === undefined) return false;
    const initializerDetails = unwrapExpressionDetails(initializer);
    const unwrappedInitializer = initializerDetails.expression;
    const initializerCallee = ts.isCallExpression(unwrappedInitializer)
      ? unwrapExpression(unwrappedInitializer.expression)
      : undefined;
    const initializerLoaderOrigin =
      initializerCallee === undefined
        ? undefined
        : resolveOrigin(initializerCallee);
    const directModuleLoad =
      ts.isCallExpression(unwrappedInitializer) &&
      ((unwrappedInitializer.expression.kind === ts.SyntaxKind.ImportKeyword &&
        initializerDetails.awaited) ||
        (initializerCallee !== undefined &&
          ts.isIdentifier(initializerCallee) &&
          initializerCallee.text === "require" &&
          isAvailableGlobal(initializerCallee)) ||
        (initializerLoaderOrigin?.kind === "member" &&
          initializerLoaderOrigin.module === "global" &&
          initializerLoaderOrigin.member === "require"));
    const depth = origin.depth + (directModuleLoad ? 0 : 1);
    if (depth > input.limits.maxAliasDepth) {
      truncations.add("alias_depth");
      resolutionIncomplete = true;
      return false;
    }
    const resolution =
      depth === 0 ? origin.resolution : "bounded_alias_resolved";
    if (ts.isIdentifier(declaration.name)) {
      return bind(declaration.name, { ...origin, depth, resolution });
    }
    if (!ts.isObjectBindingPattern(declaration.name) || origin.kind !== "module") {
      return false;
    }
    let changed = false;
    for (const element of declaration.name.elements) {
      if (!ts.isIdentifier(element.name) || element.dotDotDotToken !== undefined) {
        continue;
      }
      const memberNode = element.propertyName ?? element.name;
      const member =
        ts.isIdentifier(memberNode) || ts.isStringLiteralLike(memberNode)
          ? memberNode.text
          : undefined;
      if (member === undefined) continue;
      changed =
        bind(
          element.name,
          moduleMemberOrigin(
            { kind: "module", module: origin.module, depth, resolution },
            member,
          ),
        ) || changed;
    }
    return changed;
  }

  let aliasPasses = 0;
  let changed = true;
  while (changed && aliasPasses < input.limits.maxAliasPasses) {
    changed = false;
    aliasPasses += 1;
    for (const declaration of immutableDeclarations) {
      changed = bindDeclaration(declaration) || changed;
    }
  }
  if (changed) {
    const unresolvedResolvableAlias = immutableDeclarations.some((declaration) => {
      if (declaration.initializer === undefined) return false;
      const origin = resolveOrigin(declaration.initializer);
      if (origin === undefined) return false;
      if (ts.isIdentifier(declaration.name)) {
        const symbol = checker.getSymbolAtLocation(declaration.name);
        return symbol !== undefined && !origins.has(symbol);
      }
      return false;
    });
    if (unresolvedResolvableAlias) {
      truncations.add("alias_passes");
      resolutionIncomplete = true;
    }
  }

  for (const declaration of immutableDeclarations) {
    if (declaration.initializer === undefined) continue;
    const origin = resolveOrigin(declaration.initializer);
    if (origin === undefined || ts.isIdentifier(declaration.name)) continue;
    const supportedObjectPattern =
      origin.kind === "module" &&
      ts.isObjectBindingPattern(declaration.name) &&
      declaration.name.elements.every((element) => {
        const memberNode = element.propertyName ?? element.name;
        return (
          element.dotDotDotToken === undefined &&
          ts.isIdentifier(element.name) &&
          (ts.isIdentifier(memberNode) || ts.isStringLiteralLike(memberNode))
        );
      });
    if (supportedObjectPattern) continue;
    resolutionIncomplete = true;
    const targetPath = targetPathFromVirtual(
      declaration.getSourceFile().fileName,
    );
    addIssue({
      kind: "unsupported_binding_flow",
      ...(targetPath === undefined ? {} : { targetPath }),
      summary: `A nested, rest, computed, or non-object binding derived from the modeled '${origin.module}' module is not resolved.`,
    });
  }

  for (const declaration of nodes) {
    if (
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined
    ) {
      continue;
    }
    const identifiers = bindingIdentifiers(declaration.name);
    const mutationAffected = identifiers.some((identifier) => {
      const symbol = checker.getSymbolAtLocation(identifier);
      return symbol !== undefined && taintedSymbols.has(symbol);
    });
    if (isConstVariableDeclaration(declaration) && !mutationAffected) continue;
    const origin = resolveOrigin(declaration.initializer);
    if (origin === undefined) continue;
    resolutionIncomplete = true;
    const targetPath = targetPathFromVirtual(
      declaration.getSourceFile().fileName,
    );
    addIssue({
      kind: "unsupported_binding_flow",
      ...(targetPath === undefined ? {} : { targetPath }),
      summary: mutationAffected
        ? `A mutation-affected binding derived from the modeled '${origin.module}' module is not resolved.`
        : `A mutable binding derived from the modeled '${origin.module}' module is not resolved.`,
    });
  }

  for (const node of nodes) {
    if (
      !ts.isElementAccessExpression(node) ||
      staticMemberName(node) !== undefined
    ) {
      continue;
    }
    const base = resolveOrigin(node.expression);
    if (base?.kind !== "module") continue;
    const targetPath = targetPathFromVirtual(node.getSourceFile().fileName);
    resolutionIncomplete = true;
    addIssue({
      kind: "unsupported_binding_flow",
      ...(targetPath === undefined ? {} : { targetPath }),
      summary: `Dynamic member selection on the modeled '${base.module}' module is not resolved.`,
    });
  }

  const callsites: SemanticCallsite[] = [];
  const callsiteIds = new Set<string>();

  function addCallsite(
    node: ts.Node,
    sink: NodeSemanticSink,
    origin: Pick<Origin, "depth" | "resolution">,
  ): void {
    if (callsites.length >= input.limits.maxCallsites) {
      truncations.add("callsites");
      resolutionIncomplete = true;
      return;
    }
    const sourceFile = node.getSourceFile();
    const targetPath = targetPathFromVirtual(sourceFile.fileName);
    const source =
      targetPath === undefined ? undefined : sourceByTargetPath.get(targetPath);
    if (source === undefined || targetPath === undefined) return;
    const id = callsiteId({ source, node, sink });
    if (callsiteIds.has(id)) return;
    callsiteIds.add(id);
    const position = sourceFile.getLineAndCharacterOfPosition(
      node.getStart(sourceFile, false),
    );
    callsites.push({
      callsiteId: id,
      sinkId: sink.sinkId,
      capability: sink.capability,
      operation: sink.operation,
      api: { module: sink.module, member: sink.member },
      resolution: origin.resolution,
      aliasDepth: origin.depth,
      span: { start: node.getStart(sourceFile, false), end: node.getEnd() },
      handlerReachability: "not_assessed",
      callPath: [],
      evidence: {
        ...source.evidence,
        line: position.line + 1,
        column: position.character + 1,
      },
      excerpt: sourceExcerpt(node, sourceFile),
    });
  }

  function globalSink(
    identifier: ts.Identifier,
    operation: SemanticOperation,
  ): NodeSemanticSink | undefined {
    if (!isAvailableGlobal(identifier)) return undefined;
    return findNodeSemanticSink({
      module: "global",
      member: identifier.text,
      operation,
    });
  }

  for (const node of nodes) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      !purelyTypeOnlyImport(node) &&
      node.moduleSpecifier.text.endsWith(".node")
    ) {
      const sink = findNodeSemanticSink({
        module: "global",
        member: "import.node_addon",
        operation: "module_load",
      });
      if (sink !== undefined) {
        addCallsite(node, sink, { depth: 0, resolution: "syntax_resolved" });
      }
      continue;
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = literalText(node.arguments[0]);
        const sink = findNodeSemanticSink({
          module: "global",
          member:
            specifier?.endsWith(".node") === true
              ? "import.node_addon"
              : "import",
          operation: "module_load",
        });
        if (
          sink !== undefined &&
          (specifier === undefined || specifier.endsWith(".node"))
        ) {
          addCallsite(node, sink, { depth: 0, resolution: "syntax_resolved" });
        }
        continue;
      }
      if (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        isAvailableGlobal(callee)
      ) {
        const specifier = literalText(node.arguments[0]);
        const member =
          specifier?.endsWith(".node") === true
            ? "require.node_addon"
            : specifier === undefined
              ? "require"
              : undefined;
        if (member !== undefined) {
          const sink = findNodeSemanticSink({
            module: "global",
            member,
            operation: "module_load",
          });
          if (sink !== undefined) {
            addCallsite(node, sink, {
              depth: 0,
              resolution: "syntax_resolved",
            });
          }
        }
        continue;
      }
      if (ts.isIdentifier(callee)) {
        const sink = globalSink(callee, "call");
        if (sink !== undefined) {
          addCallsite(node, sink, { depth: 0, resolution: "syntax_resolved" });
          continue;
        }
      }
      const origin = resolveOrigin(node.expression);
      if (
        origin?.kind === "member" &&
        origin.module === "global" &&
        origin.member === "require"
      ) {
        const specifier = literalText(node.arguments[0]);
        const member =
          specifier?.endsWith(".node") === true
            ? "require.node_addon"
            : specifier === undefined
              ? "require"
              : undefined;
        if (member !== undefined) {
          const sink = findNodeSemanticSink({
            module: "global",
            member,
            operation: "module_load",
          });
          if (sink !== undefined) addCallsite(node, sink, origin);
        }
        continue;
      }
      if (origin?.kind === "member") {
        const sink = findNodeSemanticSink({
          module: origin.module,
          member: origin.member,
          operation: "call",
        });
        if (sink !== undefined) addCallsite(node, sink, origin);
      }
      continue;
    }
    if (ts.isNewExpression(node)) {
      let sink: NodeSemanticSink | undefined;
      let origin: Origin | undefined;
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee)) {
        sink = globalSink(callee, "construct");
      }
      if (sink === undefined) {
        origin = resolveOrigin(node.expression);
        if (origin?.kind === "member") {
          sink = findNodeSemanticSink({
            module: origin.module,
            member: origin.member,
            operation: "construct",
          });
        }
      }
      if (sink !== undefined) {
        addCallsite(
          node,
          sink,
          origin ?? { depth: 0, resolution: "syntax_resolved" },
        );
      }
      continue;
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const origin = resolveOrigin(node);
      if (origin?.kind === "member") {
        const sink = findNodeSemanticSink({
          module: origin.module,
          member: origin.member,
          operation: "property_access",
        });
        if (sink !== undefined) addCallsite(node, sink, origin);
      }
      continue;
    }
    if (ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      const origin = symbol === undefined ? undefined : origins.get(symbol);
      if (origin?.kind === "member") {
        const sink = findNodeSemanticSink({
          module: origin.module,
          member: origin.member,
          operation: "property_access",
        });
        if (sink !== undefined) addCallsite(node, sink, origin);
      }
    }
  }

  callsites.sort(
    (left, right) =>
      compareText(left.evidence.targetPath, right.evidence.targetPath) ||
      (left.evidence.line ?? 0) - (right.evidence.line ?? 0) ||
      (left.evidence.column ?? 0) - (right.evidence.column ?? 0) ||
      compareText(left.sinkId, right.sinkId),
  );
  issues.sort(
    (left, right) =>
      compareText(left.targetPath ?? "", right.targetPath ?? "") ||
      compareText(left.kind, right.kind) ||
      compareText(left.summary, right.summary),
  );

  const filesWithSyntaxErrors = files.filter(
    (file) => file.parseStatus === "syntax_errors",
  ).length;
  const orderedTruncations = [...truncations].sort(compareText);
  const incomplete =
    filesWithSyntaxErrors > 0 ||
    resolutionIncomplete ||
    orderedTruncations.length > 0;
  return nodeSemanticStaticV1Schema.parse({
    schema: "forge.node-semantic-static/v1",
    runId: input.runId,
    targetId: input.targetId,
    generatedAt: input.generatedAt,
    status: incomplete ? "partial" : "completed",
    analyzer: {
      engine: "typescript-compiler-api",
      package: "typescript-semantic",
      version: ts.version,
      catalogVersion: NODE_SEMANTIC_CATALOG_VERSION,
    },
    input: {
      lexicalInspectionArtifact: input.lexicalInspectionArtifact,
      lexicalInspectionSha256: input.lexicalInspectionSha256,
      sourceSetSha256: input.sourceSetSha256,
    },
    limits: input.limits,
    coverage: {
      inputFiles: files.length,
      inputBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      parsedFiles: files.length,
      filesWithSyntaxErrors,
      astNodesVisited,
      callExpressionsVisited,
      handlerRootsIdentified: 0,
      localCallGraphEdges: 0,
      moduleResolutionsAttempted,
      moduleResolutionsUnresolved,
      resolutionIncomplete,
    },
    files,
    callsites,
    issues,
    truncations: orderedTruncations,
    limitations: [
      "This bounded sidecar identifies modeled sensitive API callsites; it does not prove that a callsite executes.",
      "MCP-handler reachability and source-to-sink data flow are not assessed in this version.",
      "The closed compiler host analyzes only source bytes captured by the lexical inspection and does not load target tsconfig files, plugins, dependencies, or host files.",
      "Mutable bindings and bindings affected by syntactically detected assignment, delete, or update mutations are withheld regardless of source order and make coverage partial; reflective mutation, dynamic property names, third-party wrappers, and native behavior can remain unresolved.",
      "Worker resource limits bound V8 heap generations and stack only; they are not a total-RSS or OS-permission sandbox.",
    ],
  });
}
