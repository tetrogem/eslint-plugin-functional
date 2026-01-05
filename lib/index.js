import { deepmerge } from 'deepmerge-ts';
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/utils';
import { RuleCreator, getParserServices } from '@typescript-eslint/utils/eslint-utils';
import { createRequire } from 'node:module';
import { Immutability, getDefaultOverrides, getTypeImmutability } from 'is-immutable-type';
import { isIntrinsicErrorType, isTupleTypeReference } from 'ts-api-utils';
import typeMatchesSpecifier from 'ts-declaration-location';
import escapeRegExp from 'escape-string-regexp';

const require$1 = createRequire(import.meta.url);
var typescript = (() => {
    try {
        return require$1("typescript");
    }
    catch {
        return undefined;
    }
})();
// export default (await import("typescript")
//   .then((r) => r.default)
//   .catch(() => undefined)) as typeof typescript | undefined;

/**
 * The settings that have been loaded - so we don't have to reload them.
 */
const cachedSettings = new WeakMap();
/**
 * Get the immutability overrides defined in the settings.
 */
function getImmutabilityOverrides({ immutability, }) {
    if (immutability === undefined) {
        return undefined;
    }
    if (!cachedSettings.has(immutability)) {
        const overrides = loadImmutabilityOverrides(immutability);
        cachedSettings.set(immutability, overrides);
        return overrides;
    }
    return cachedSettings.get(immutability);
}
/**
 * Get all the overrides and upgrade them.
 */
function loadImmutabilityOverrides(immutabilitySettings) {
    const overridesSetting = immutabilitySettings?.overrides;
    if (overridesSetting === undefined) {
        return undefined;
    }
    const raw = Array.isArray(overridesSetting) ? overridesSetting : (overridesSetting.values ?? []);
    const upgraded = raw.map((rawValue) => {
        const { type, to, from, ...rest } = rawValue;
        const value = {
            type,
            to: typeof to === "string" ? Immutability[to] : to,
            from: from === undefined ? undefined : typeof from === "string" ? Immutability[from] : from,
        };
        if (value.type === undefined) {
            throw new Error(`Override is missing required "type" property. Value: "${JSON.stringify(rawValue)}"`);
        }
        if (value.to === undefined) {
            throw new Error(`Override is missing required "to" property. Value: "${JSON.stringify(rawValue)}"`);
        }
        const restKeys = Object.keys(rest);
        if (restKeys.length > 0) {
            throw new Error(`Override is contains unknown property(s) "${restKeys.join(", ")}". Value: "${JSON.stringify(rawValue)}"`);
        }
        return value;
    });
    const keepDefault = Array.isArray(overridesSetting) || overridesSetting.keepDefault !== false;
    return keepDefault ? [...getDefaultOverrides(), ...upgraded] : upgraded;
}

// eslint-disable-next-line ts/naming-convention -- This is a special var.
const __VERSION__ = "0.0.0-development";

function typeMatchesPattern(program, type, typeNode, include, exclude = []) {
    if (include.length === 0) {
        return false;
    }
    let mut_shouldInclude = false;
    const typeNameAlias = getTypeAliasName(type, typeNode);
    if (typeNameAlias !== null) {
        const testTypeNameAlias = (pattern) => typeof pattern === "string" ? pattern === typeNameAlias : pattern.test(typeNameAlias);
        if (exclude.some(testTypeNameAlias)) {
            return false;
        }
        mut_shouldInclude ||= include.some(testTypeNameAlias);
    }
    const typeValue = getTypeAsString(program, type, typeNode);
    const testTypeValue = (pattern) => typeof pattern === "string" ? pattern === typeValue : pattern.test(typeValue);
    if (exclude.some(testTypeValue)) {
        return false;
    }
    mut_shouldInclude ||= include.some(testTypeValue);
    const typeNameName = extractTypeName(typeValue);
    if (typeNameName !== null) {
        const testTypeNameName = (pattern) => typeof pattern === "string" ? pattern === typeNameName : pattern.test(typeNameName);
        if (exclude.some(testTypeNameName)) {
            return false;
        }
        mut_shouldInclude ||= include.some(testTypeNameName);
    }
    // Special handling for arrays not written in generic syntax.
    if (program.getTypeChecker().isArrayType(type) && typeNode !== null) {
        if ((typescript.isTypeOperatorNode(typeNode) && typeNode.operator === typescript.SyntaxKind.ReadonlyKeyword) ||
            (typescript.isTypeOperatorNode(typeNode.parent) && typeNode.parent.operator === typescript.SyntaxKind.ReadonlyKeyword)) {
            const testIsReadonlyArray = (pattern) => typeof pattern === "string" && pattern === "ReadonlyArray";
            if (exclude.some(testIsReadonlyArray)) {
                return false;
            }
            mut_shouldInclude ||= include.some(testIsReadonlyArray);
        }
        else {
            const testIsArray = (pattern) => typeof pattern === "string" && pattern === "Array";
            if (exclude.some(testIsArray)) {
                return false;
            }
            mut_shouldInclude ||= include.some(testIsArray);
        }
    }
    return mut_shouldInclude;
}
/**
 * Get the type alias name from the given type data.
 *
 * Null will be returned if the type is not a type alias.
 */
function getTypeAliasName(type, typeNode) {
    if (typeNode === null) {
        const t = "target" in type ? type.target : type;
        return t.aliasSymbol?.getName() ?? null;
    }
    return typescript.isTypeAliasDeclaration(typeNode.parent) ? typeNode.parent.name.getText() : null;
}
/**
 * Get the type as a string.
 */
function getTypeAsString(program, type, typeNode) {
    return typeNode === null
        ? program
            .getTypeChecker()
            .typeToString(type, undefined, typescript.TypeFormatFlags.AddUndefined |
            typescript.TypeFormatFlags.NoTruncation |
            typescript.TypeFormatFlags.OmitParameterModifiers |
            typescript.TypeFormatFlags.UseFullyQualifiedType |
            typescript.TypeFormatFlags.WriteArrayAsGenericType |
            typescript.TypeFormatFlags.WriteArrowStyleSignature |
            typescript.TypeFormatFlags.WriteTypeArgumentsOfSignature)
        : typeNode.getText();
}
/**
 * Get the type name extracted from the the type's string.
 *
 * This only work if the type is a type reference.
 */
function extractTypeName(typeValue) {
    const match = /^([^<]+)<.+>$/u.exec(typeValue);
    return match?.[1] ?? null;
}

/**
 * Create a function that processes common options and then runs the given
 * check.
 */
function checkNode(check, context, options) {
    return (node) => {
        const result = check(node, context, options);
        // eslint-disable-next-line functional/no-loop-statements -- can't really be avoided.
        for (const descriptor of result.descriptors) {
            result.context.report(descriptor);
        }
    };
}
/**
 * Create a rule.
 */
function createRule(name, meta, defaultOptions, ruleFunctionsMap) {
    return createRuleUsingFunction(name, meta, defaultOptions, () => ruleFunctionsMap);
}
/**
 * Create a rule.
 */
function createRuleUsingFunction(name, meta, defaultOptions, createFunction) {
    const ruleCreator = RuleCreator((ruleName) => `https://github.com/eslint-functional/eslint-plugin-functional/blob/v${__VERSION__}/docs/rules/${ruleName}.md`);
    return ruleCreator({
        name,
        meta,
        defaultOptions,
        create: (context, options) => {
            const ruleFunctionsMap = createFunction(context, options);
            return Object.fromEntries(Object.entries(ruleFunctionsMap).map(([nodeSelector, ruleFunction]) => [
                nodeSelector,
                checkNode(ruleFunction, context, options),
            ]));
        },
    });
}
/**
 * Get the type of the the given node.
 */
function getTypeOfNode(node, context) {
    const { esTreeNodeToTSNodeMap } = getParserServices(context);
    const tsNode = esTreeNodeToTSNodeMap.get(node);
    return getTypeOfTSNode(tsNode, context);
}
/**
 * Get the type of the the given node.
 */
function getTypeDataOfNode(node, context) {
    const { esTreeNodeToTSNodeMap } = getParserServices(context);
    const tsNode = esTreeNodeToTSNodeMap.get(node);
    return [getTypeOfTSNode(tsNode, context), tsNode.type ?? null];
}
/**
 * Get the type of the the given ts node.
 */
function getTypeOfTSNode(node, context) {
    const { program } = getParserServices(context);
    const checker = program.getTypeChecker();
    const nodeType = checker.getTypeAtLocation(node);
    const constrained = checker.getBaseConstraintOfType(nodeType);
    return constrained ?? nodeType;
}
/**
 * Get the return type of the the given function node.
 */
function getReturnTypesOfFunction(node, context) {
    if (typescript === undefined) {
        return null;
    }
    const parserServices = getParserServices(context);
    const checker = parserServices.program.getTypeChecker();
    const type = getTypeOfNode(node, context);
    const signatures = checker.getSignaturesOfType(type, typescript.SignatureKind.Call);
    return signatures.map((signature) => checker.getReturnTypeOfSignature(signature));
}
/**
 * Does the given function have overloads?
 */
function isImplementationOfOverload(func, context) {
    if (typescript === undefined) {
        return false;
    }
    const parserServices = getParserServices(context);
    const checker = parserServices.program.getTypeChecker();
    const signature = parserServices.esTreeNodeToTSNodeMap.get(func);
    return checker.isImplementationOfOverload(signature) === true;
}
/**
 * Get the type immutability of the the given node or type.
 */
function getTypeImmutabilityOfNode(node, context, maxImmutability, explicitOverrides) {
    if (typescript === undefined) {
        return Immutability.Unknown;
    }
    const parserServices = getParserServices(context);
    const overrides = getImmutabilityOverrides(context.settings);
    const tsNode = parserServices.esTreeNodeToTSNodeMap.get(node);
    let mut_typeLike = tsNode.type;
    if (mut_typeLike === undefined) {
        mut_typeLike = getTypeOfTSNode(tsNode, context);
        if (isIntrinsicErrorType(mut_typeLike)) {
            return Immutability.Unknown;
        }
    }
    return getTypeImmutability(parserServices.program, mut_typeLike, overrides, 
    // Don't use the global cache in testing environments as it may cause errors when switching between different config options.
    process.env["NODE_ENV"] !== "test", maxImmutability, typeMatchesPattern);
}
/**
 * Get the type immutability of the the given type.
 */
function getTypeImmutabilityOfType(typeOrTypeNode, context, maxImmutability, explicitOverrides) {
    const parserServices = getParserServices(context);
    const overrides = getImmutabilityOverrides(context.settings);
    return getTypeImmutability(parserServices.program, typeOrTypeNode, overrides, 
    // Don't use the global cache in testing environments as it may cause errors when switching between different config options.
    process.env["NODE_ENV"] !== "test", maxImmutability);
}

/**
 * @file Functions that type guard the given node/type.
 */
const libSpecifier = {
    from: "lib",
};
/*
 * Node type guards.
 */
function isArrayExpression(node) {
    return node.type === AST_NODE_TYPES.ArrayExpression;
}
function isArrayPattern(node) {
    return node.type === AST_NODE_TYPES.ArrayPattern;
}
function isAssignmentExpression(node) {
    return node.type === AST_NODE_TYPES.AssignmentExpression;
}
function isAssignmentPattern(node) {
    return node.type === AST_NODE_TYPES.AssignmentPattern;
}
function isBlockStatement(node) {
    return node.type === AST_NODE_TYPES.BlockStatement;
}
function isBreakStatement(node) {
    return node.type === AST_NODE_TYPES.BreakStatement;
}
function isCallExpression(node) {
    return node.type === AST_NODE_TYPES.CallExpression;
}
function isChainExpression(node) {
    return node.type === AST_NODE_TYPES.ChainExpression;
}
function isPropertyDefinition(node) {
    return node.type === AST_NODE_TYPES.PropertyDefinition;
}
/**
 * Is the given node a class node?
 *
 * It doesn't matter what type of class.
 */
function isClassLike(node) {
    return node.type === AST_NODE_TYPES.ClassDeclaration || node.type === AST_NODE_TYPES.ClassExpression;
}
function isContinueStatement(node) {
    return node.type === AST_NODE_TYPES.ContinueStatement;
}
function isExpressionStatement(node) {
    return node.type === AST_NODE_TYPES.ExpressionStatement;
}
function isForStatement(node) {
    return node.type === AST_NODE_TYPES.ForStatement;
}
function isFunctionDeclaration(node) {
    return node.type === AST_NODE_TYPES.FunctionDeclaration;
}
/**
 * Is the given node a function expression node?
 *
 * It doesn't matter what type of function expression.
 */
function isFunctionExpressionLike(node) {
    return node.type === AST_NODE_TYPES.FunctionExpression || node.type === AST_NODE_TYPES.ArrowFunctionExpression;
}
/**
 * Is the given node a function node?
 *
 * It doesn't matter what type of function.
 */
function isFunctionLike(node) {
    return isFunctionDeclaration(node) || isFunctionExpressionLike(node);
}
function isIdentifier(node) {
    return node.type === AST_NODE_TYPES.Identifier;
}
function isIfStatement(node) {
    return node.type === AST_NODE_TYPES.IfStatement;
}
function isLabeledStatement(node) {
    return node.type === AST_NODE_TYPES.LabeledStatement;
}
function isMemberExpression(node) {
    return node.type === AST_NODE_TYPES.MemberExpression;
}
function isMethodDefinition(node) {
    return node.type === AST_NODE_TYPES.MethodDefinition;
}
function isNewExpression(node) {
    return node.type === AST_NODE_TYPES.NewExpression;
}
function isObjectExpression(node) {
    return node.type === AST_NODE_TYPES.ObjectExpression;
}
function isObjectPattern(node) {
    return node.type === AST_NODE_TYPES.ObjectPattern;
}
function isPrivateIdentifier(node) {
    return node.type === AST_NODE_TYPES.PrivateIdentifier;
}
function isProgram(node) {
    return node.type === AST_NODE_TYPES.Program;
}
function isProperty(node) {
    return node.type === AST_NODE_TYPES.Property;
}
function isRestElement(node) {
    return node.type === AST_NODE_TYPES.RestElement;
}
function isReturnStatement(node) {
    return node.type === AST_NODE_TYPES.ReturnStatement;
}
function isSwitchStatement(node) {
    return node.type === AST_NODE_TYPES.SwitchStatement;
}
function isThisExpression(node) {
    return node.type === AST_NODE_TYPES.ThisExpression;
}
function isThrowStatement(node) {
    return node.type === AST_NODE_TYPES.ThrowStatement;
}
function isTryStatement(node) {
    return node.type === AST_NODE_TYPES.TryStatement;
}
function isTSArrayType(node) {
    return node.type === AST_NODE_TYPES.TSArrayType;
}
function isTSAsExpression(node) {
    return node.type === AST_NODE_TYPES.TSAsExpression;
}
function isTSFunctionType(node) {
    return node.type === AST_NODE_TYPES.TSFunctionType;
}
function isTSIndexSignature(node) {
    return node.type === AST_NODE_TYPES.TSIndexSignature;
}
function isTSMethodSignature(node) {
    return node.type === AST_NODE_TYPES.TSMethodSignature;
}
function isTSCallSignatureDeclaration(node) {
    return node.type === AST_NODE_TYPES.TSCallSignatureDeclaration;
}
function isTSConstructSignatureDeclaration(node) {
    return node.type === AST_NODE_TYPES.TSConstructSignatureDeclaration;
}
function isTSInterfaceBody(node) {
    return node.type === AST_NODE_TYPES.TSInterfaceBody;
}
function isTSInterfaceDeclaration(node) {
    return node.type === AST_NODE_TYPES.TSInterfaceDeclaration;
}
function isTSInterfaceHeritage(node) {
    return node.type === AST_NODE_TYPES.TSInterfaceHeritage;
}
function isTSNonNullExpression(node) {
    return node.type === AST_NODE_TYPES.TSNonNullExpression;
}
function isTSNullKeyword(node) {
    return node.type === AST_NODE_TYPES.TSNullKeyword;
}
function isTSParameterProperty(node) {
    return node.type === AST_NODE_TYPES.TSParameterProperty;
}
function isTSPropertySignature(node) {
    return node.type === AST_NODE_TYPES.TSPropertySignature;
}
function isTSTupleType(node) {
    return node.type === AST_NODE_TYPES.TSTupleType;
}
function isTSTypeAnnotation(node) {
    return node.type === AST_NODE_TYPES.TSTypeAnnotation;
}
function isTSTypeLiteral(node) {
    return node.type === AST_NODE_TYPES.TSTypeLiteral;
}
function isTSTypeOperator(node) {
    return node.type === AST_NODE_TYPES.TSTypeOperator;
}
function isTSTypePredicate(node) {
    return node.type === AST_NODE_TYPES.TSTypePredicate;
}
function isTSTypeReference(node) {
    return node.type === AST_NODE_TYPES.TSTypeReference;
}
function isTSUndefinedKeyword(node) {
    return node.type === AST_NODE_TYPES.TSUndefinedKeyword;
}
function isTSVoidKeyword(node) {
    return node.type === AST_NODE_TYPES.TSVoidKeyword;
}
function isUnaryExpression(node) {
    return node.type === AST_NODE_TYPES.UnaryExpression;
}
function isVariableDeclaration(node) {
    return node.type === AST_NODE_TYPES.VariableDeclaration;
}
function isYieldExpression(node) {
    return node.type === AST_NODE_TYPES.YieldExpression;
}
function hasID(node) {
    return Object.hasOwn(node, "id");
}
function hasKey(node) {
    return Object.hasOwn(node, "key");
}
function isDefined(value) {
    return value !== null && value !== undefined;
}
/*
 * TS types type guards.
 */
function isUnionType(type) {
    return typescript !== undefined && type.flags === typescript.TypeFlags.Union;
}
function isFunctionLikeType(type) {
    return type !== null && type.getCallSignatures().length > 0;
}
function isArrayType(context, type) {
    return typeMatches(context, "Array", type);
}
function isMapType(context, type) {
    return typeMatches(context, "Map", type);
}
function isSetType(context, type) {
    return typeMatches(context, "Set", type);
}
function isArrayConstructorType(context, type) {
    return typeMatches(context, "ArrayConstructor", type);
}
function isMapConstructorType(context, type) {
    return typeMatches(context, "MapConstructor", type);
}
function isSetConstructorType(context, type) {
    return typeMatches(context, "SetConstructor", type);
}
function isObjectConstructorType(context, type) {
    return typeMatches(context, "ObjectConstructor", type);
}
function isPromiseType(context, type) {
    return typeMatches(context, "Promise", type);
}
function typeMatches(context, typeName, type) {
    if (type === null) {
        return false;
    }
    const program = context.sourceCode.parserServices?.program ?? undefined;
    if (program === undefined) {
        return false;
    }
    return typeMatchesHelper(program, typeName)(type);
}
function typeMatchesHelper(program, typeName) {
    return function test(type) {
        return ((type.symbol !== undefined &&
            type.symbol.name === typeName &&
            typeMatchesSpecifier(program, libSpecifier, type)) ||
            (isUnionType(type) && type.types.some(test)));
    };
}

/**
 * Return the first ancestor that meets the given check criteria.
 */
function getAncestorOfType(checker, node, child = null) {
    return checker(node, child) ? node : isDefined(node.parent) ? getAncestorOfType(checker, node.parent, node) : null;
}
/**
 * Test if the given node is in a function's body.
 *
 * @param node - The node to test.
 * @param async - Whether the function must be async or sync. Use `undefined` for either.
 */
function isInFunctionBody(node, async) {
    const functionNode = getEnclosingFunction(node);
    return functionNode !== null && (async === undefined);
}
/**
 * Get the function the given node is in.
 *
 * Will return null if not in a function.
 */
function getEnclosingFunction(node) {
    return getAncestorOfType((n, c) => isFunctionLike(n) && n.body === c, node);
}
/**
 * Get the function the given node is in.
 *
 * Will return null if not in a function.
 */
function getEnclosingTryStatement(node) {
    return getAncestorOfType((n, c) => isTryStatement(n) && n.block === c, node);
}
/**
 * Test if the given node is in a class.
 */
function isInClass(node) {
    return getAncestorOfType(isClassLike, node) !== null;
}
/**
 * Test if the given node is in a for loop initializer.
 */
function isInForLoopInitializer(node) {
    return getAncestorOfType((n, c) => isForStatement(n) && n.init === c, node) !== null;
}
/**
 * Test if the given node is shallowly inside a `Readonly<{...}>`.
 */
function isInReadonly(node) {
    return getReadonly(node) !== null;
}
/**
 * Test if the given node is in a handler function callback of a promise.
 */
function isInPromiseHandlerFunction(node, context) {
    const functionNode = getAncestorOfType((n, c) => isFunctionLike(n) && n.body === c, node);
    if (functionNode === null ||
        !isCallExpression(functionNode.parent) ||
        !isMemberExpression(functionNode.parent.callee) ||
        !isIdentifier(functionNode.parent.callee.property)) {
        return false;
    }
    const objectType = getTypeOfNode(functionNode.parent.callee.object, context);
    return isPromiseType(context, objectType);
}
/**
 * Test if the given node is shallowly inside a `Readonly<{...}>`.
 */
function getReadonly(node) {
    // For nested cases, we shouldn't look for any parent, but the immediate parent.
    if (isDefined(node.parent) &&
        isTSTypeLiteral(node.parent) &&
        isDefined(node.parent.parent) &&
        isTSTypeAnnotation(node.parent.parent)) {
        return null;
    }
    const typeRef = getAncestorOfType(isTSTypeReference, node);
    const intHeritage = getAncestorOfType(isTSInterfaceHeritage, node);
    const expressionOrTypeName = typeRef?.typeName ?? intHeritage?.expression;
    return expressionOrTypeName !== undefined &&
        isIdentifier(expressionOrTypeName) &&
        expressionOrTypeName.name === "Readonly"
        ? (typeRef ?? intHeritage)
        : null;
}
/**
 * Test if the given node is in a TS Property Signature.
 */
function isInInterface(node) {
    return getAncestorOfType(isTSInterfaceBody, node) !== null;
}
/**
 * Test if the given node is in a Constructor.
 */
function isInConstructor(node) {
    const methodDefinition = getAncestorOfType(isMethodDefinition, node);
    return methodDefinition !== null && isIdentifier(methodDefinition.key) && methodDefinition.key.name === "constructor";
}
/**
 * Is the given node in the return type.
 */
function isInReturnType(node) {
    return (getAncestorOfType((n) => isDefined(n.parent) && isFunctionLike(n.parent) && n.parent.returnType === n, node) !== null);
}
/**
 * Test if the given node is nested inside another statement.
 */
function isNested(node) {
    return node.parent !== undefined && !(isProgram(node.parent) || isBlockStatement(node.parent));
}
/**
 * Is the given identifier a property of an object?
 */
function isPropertyAccess(node) {
    return node.parent !== undefined && isMemberExpression(node.parent) && node.parent.property === node;
}
/**
 * Is the given identifier a property name?
 */
function isPropertyName(node) {
    return node.parent !== undefined && isProperty(node.parent) && node.parent.key === node;
}
/**
 * Is the given function an IIFE?
 */
function isIIFE(node) {
    return (isFunctionExpressionLike(node) &&
        node.parent !== undefined &&
        isCallExpression(node.parent) &&
        node.parent.callee === node);
}
/**
 * Is the given node being passed as an argument?
 */
function isArgument(node) {
    return node.parent !== undefined && isCallExpression(node.parent) && node.parent.arguments.includes(node);
}
/**
 * Is the given node a parameter?
 */
function isParameter(node) {
    return node.parent !== undefined && isFunctionLike(node.parent) && node.parent.params.includes(node);
}
/**
 * Is the given node a getter function?
 */
function isGetter(node) {
    return node.parent !== undefined && isProperty(node.parent) && node.parent.kind === "get";
}
/**
 * Is the given node a setter function?
 */
function isSetter(node) {
    return node.parent !== undefined && isProperty(node.parent) && node.parent.kind === "set";
}
/**
 * Get the key the given node is assigned to in its parent ObjectExpression.
 */
function getKeyOfValueInObjectExpression(node) {
    if (!isDefined(node.parent)) {
        return null;
    }
    const objectExpression = getAncestorOfType(isObjectExpression, node);
    if (objectExpression === null) {
        return null;
    }
    const objectExpressionProps = objectExpression.properties.filter((prop) => isProperty(prop) && prop.value === node);
    if (objectExpressionProps.length !== 1) {
        return null;
    }
    const objectExpressionProp = objectExpressionProps[0];
    if (!isProperty(objectExpressionProp) || !isIdentifier(objectExpressionProp.key)) {
        return null;
    }
    return objectExpressionProp.key.name;
}
/**
 * Is the given identifier defined by a mutable variable (let or var)?
 */
function isDefinedByMutableVariable(node, context, treatParametersAsMutable) {
    const services = getParserServices(context);
    const symbol = services.getSymbolAtLocation(node);
    const variableDeclaration = symbol?.valueDeclaration;
    if (variableDeclaration === undefined) {
        return true;
    }
    const variableDeclarationNode = services.tsNodeToESTreeNodeMap.get(variableDeclaration);
    if (variableDeclarationNode !== undefined && isParameter(variableDeclarationNode)) {
        return treatParametersAsMutable(variableDeclarationNode);
    }
    if (!typescript.isVariableDeclaration(variableDeclaration)) {
        return true;
    }
    const variableDeclarator = services.tsNodeToESTreeNodeMap.get(variableDeclaration);
    if (variableDeclarator?.parent === undefined || !isVariableDeclaration(variableDeclarator.parent)) {
        return true;
    }
    return variableDeclarator.parent.kind !== "const";
}
/**
 * Get the root identifier of an expression.
 */
function findRootIdentifier(node) {
    if (isIdentifier(node)) {
        return node;
    }
    if (isMemberExpression(node)) {
        return findRootIdentifier(node.object);
    }
    return undefined;
}

const ruleNameScope = "functional";
/**
 * Does the given ExpressionStatement specify directive prologues.
 */
function isDirectivePrologue(node) {
    return (node.expression.type === AST_NODE_TYPES.Literal &&
        typeof node.expression.value === "string" &&
        node.expression.value.startsWith("use "));
}
/**
 * Get the identifier text of the given node.
 */
function getNodeIdentifierText(node, context) {
    if (!isDefined(node)) {
        return undefined;
    }
    let mut_identifierText = null;
    if (isIdentifier(node)) {
        mut_identifierText = node.name;
    }
    else if (isPrivateIdentifier(node)) {
        mut_identifierText = `#${node.name}`;
    }
    else if (hasID(node) && isDefined(node.id)) {
        mut_identifierText = getNodeIdentifierText(node.id, context);
    }
    else if (hasKey(node) && isDefined(node.key)) {
        mut_identifierText = getNodeIdentifierText(node.key, context);
    }
    else if (isAssignmentExpression(node)) {
        mut_identifierText = getNodeIdentifierText(node.left, context);
    }
    else if (isMemberExpression(node)) {
        mut_identifierText = `${getNodeIdentifierText(node.object, context)}.${getNodeIdentifierText(node.property, context)}`;
    }
    else if (isThisExpression(node)) {
        mut_identifierText = "this";
    }
    else if (isUnaryExpression(node)) {
        mut_identifierText = getNodeIdentifierText(node.argument, context);
    }
    else if (isTSTypeAnnotation(node)) {
        mut_identifierText = context.sourceCode.getText(node.typeAnnotation).replaceAll(/\s+/gu, "");
    }
    else if (isTSAsExpression(node) || isTSNonNullExpression(node) || isChainExpression(node)) {
        mut_identifierText = getNodeIdentifierText(node.expression, context);
    }
    if (mut_identifierText !== null) {
        return mut_identifierText;
    }
    const keyInObjectExpression = getKeyOfValueInObjectExpression(node);
    if (keyInObjectExpression !== null) {
        return keyInObjectExpression;
    }
    return undefined;
}
/**
 * Get the code of the given node.
 */
function getNodeCode(node, context) {
    return context.sourceCode.getText(node);
}
/**
 * Get all the identifier texts of the given node.
 */
function getNodeIdentifierTexts(node, context) {
    return (isVariableDeclaration(node)
        ? node.declarations.flatMap((declarator) => getNodeIdentifierText(declarator, context))
        : [getNodeIdentifierText(node, context)]).filter((text) => text !== undefined);
}

/**
 * The schema for the option to ignore patterns.
 */
const ignoreIdentifierPatternOptionSchema = {
    ignoreIdentifierPattern: {
        type: ["string", "array"],
        items: {
            type: "string",
        },
    },
};
/**
 * The schema for the option to ignore patterns.
 */
const ignoreCodePatternOptionSchema = {
    ignoreCodePattern: {
        type: ["string", "array"],
        items: {
            type: "string",
        },
    },
};
/**
 * The schema for the option to ignore accessor patterns.
 */
const ignoreAccessorPatternOptionSchema = {
    ignoreAccessorPattern: {
        type: ["string", "array"],
        items: {
            type: "string",
        },
    },
};
/**
 * The schema for the option to ignore classes.
 */
const ignoreClassesOptionSchema = {
    ignoreClasses: {
        oneOf: [
            {
                type: "boolean",
            },
            {
                type: "string",
                enum: ["fieldsOnly"],
            },
        ],
    },
};
/**
 * The schema for the option to ignore maps and sets.
 */
const ignoreMapsAndSetsOptionSchema = {
    ignoreMapsAndSets: {
        type: "boolean",
    },
};
/**
 * The schema for the option to ignore prefix selector.
 */
const ignorePrefixSelectorOptionSchema = {
    ignorePrefixSelector: {
        type: ["string", "array"],
        items: {
            type: "string",
        },
    },
};
/**
 * Should the given text be allowed?
 *
 * Test using the given pattern(s).
 */
function shouldIgnoreViaPattern(text, pattern) {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    // One or more patterns match?
    return patterns.some((p) => new RegExp(p, "u").test(text));
}
/**
 * Recursive callback of `shouldIgnoreViaAccessorPattern`.
 *
 * This function not be called from anywhere else.
 *
 * Does the given text match the given pattern.
 */
function accessorPatternMatch([pattern, ...remainingPatternParts], textParts, allowExtra = false) {
    return pattern === undefined
        ? allowExtra || textParts.length === 0
        : // Match any depth (including 0)?
            pattern === "**"
                ? textParts.length === 0
                    ? accessorPatternMatch(remainingPatternParts, [], allowExtra)
                    : Array.from({ length: textParts.length })
                        .map((element, index) => index)
                        .some((offset) => accessorPatternMatch(remainingPatternParts, textParts.slice(offset), true))
                : // Match anything?
                    pattern === "*"
                        ? textParts.length > 0 && accessorPatternMatch(remainingPatternParts, textParts.slice(1), allowExtra)
                        : // Text matches pattern?
                            new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".*")}$`, "u").test(textParts[0]) &&
                                accessorPatternMatch(remainingPatternParts, textParts.slice(1), allowExtra);
}
/**
 * Should the given text be allowed?
 *
 * Test using the given accessor pattern(s).
 */
function shouldIgnoreViaAccessorPattern(text, pattern) {
    const patterns = Array.isArray(pattern) ? pattern : [pattern];
    // One or more patterns match?
    return patterns.some((p) => accessorPatternMatch(p.split("."), text.split(".")));
}
/**
 * Should the given node be allowed base off the following rule options?
 *
 * - AllowInFunctionOption.
 */
function shouldIgnoreInFunction(node, context, allowInFunction) {
    return allowInFunction === true && isInFunctionBody(node);
}
/**
 * Should the given node be allowed base off the following rule options?
 *
 * - IgnoreClassesOption.
 */
function shouldIgnoreClasses(node, context, ignoreClasses) {
    return ((ignoreClasses === true && (isClassLike(node) || isInClass(node))) ||
        (ignoreClasses === "fieldsOnly" &&
            (isPropertyDefinition(node) ||
                (isAssignmentExpression(node) &&
                    isInClass(node) &&
                    isMemberExpression(node.left) &&
                    isThisExpression(node.left.object)))));
}
/**
 * Should the given node be allowed base off the following rule options?
 *
 * - IgnoreAccessorPatternOption.
 * - IgnoreIdentifierPatternOption.
 */
function shouldIgnorePattern(node, context, ignoreIdentifierPattern, ignoreAccessorPattern, ignoreCodePattern) {
    const texts = getNodeIdentifierTexts(node, context);
    if (texts.length === 0) {
        return ignoreCodePattern !== undefined && shouldIgnoreViaPattern(getNodeCode(node, context), ignoreCodePattern);
    }
    return (
    // Ignore if ignoreIdentifierPattern is set and a pattern matches.
    (ignoreIdentifierPattern !== undefined &&
        texts.every((text) => shouldIgnoreViaPattern(text, ignoreIdentifierPattern))) ||
        // Ignore if ignoreAccessorPattern is set and an accessor pattern matches.
        (ignoreAccessorPattern !== undefined &&
            texts.every((text) => shouldIgnoreViaAccessorPattern(text, ignoreAccessorPattern))) ||
        // Ignore if ignoreCodePattern is set and a code pattern matches.
        (ignoreCodePattern !== undefined && shouldIgnoreViaPattern(getNodeCode(node, context), ignoreCodePattern)));
}

function upgradeRawOverridableOptions(raw) {
    return {
        ...raw,
        overrides: raw.overrides?.map((override) => ({
            ...override,
            specifiers: override.specifiers === undefined
                ? []
                : Array.isArray(override.specifiers)
                    ? override.specifiers.map(upgradeRawTypeSpecifier)
                    : [upgradeRawTypeSpecifier(override.specifiers)],
        })) ?? [],
    };
}
function upgradeRawTypeSpecifier(raw) {
    const { ignoreName, ignorePattern, name, pattern, ...rest } = raw;
    const names = name === undefined ? [] : Array.isArray(name) ? name : [name];
    const patterns = (pattern === undefined ? [] : Array.isArray(pattern) ? pattern : [pattern]).map((p) => new RegExp(p, "u"));
    const ignoreNames = ignoreName === undefined ? [] : Array.isArray(ignoreName) ? ignoreName : [ignoreName];
    const ignorePatterns = (ignorePattern === undefined ? [] : Array.isArray(ignorePattern) ? ignorePattern : [ignorePattern]).map((p) => new RegExp(p, "u"));
    const include = [...names, ...patterns];
    const exclude = [...ignoreNames, ...ignorePatterns];
    return {
        ...rest,
        include,
        exclude,
    };
}
/**
 * Get the core options to use, taking into account overrides.
 */
function getCoreOptions(node, context, options) {
    const program = context.sourceCode.parserServices?.program ?? undefined;
    if (program === undefined) {
        return options;
    }
    const [type, typeNode] = getTypeDataOfNode(node, context);
    return getCoreOptionsForType(type, typeNode, context, options);
}
function getCoreOptionsForType(type, typeNode, context, options) {
    const program = context.sourceCode.parserServices?.program ?? undefined;
    if (program === undefined) {
        return options;
    }
    const found = options.overrides?.find((override) => (Array.isArray(override.specifiers) ? override.specifiers : [override.specifiers]).some((specifier) => typeMatchesSpecifierDeep(program, specifier, type) &&
        (specifier.include === undefined ||
            specifier.include.length === 0 ||
            typeMatchesPattern(program, type, typeNode, specifier.include, specifier.exclude))));
    if (found !== undefined) {
        if (found.disable === true) {
            return null;
        }
        if (found.inherit !== false) {
            return deepmerge(options, found.options);
        }
        return found.options;
    }
    return options;
}
function typeMatchesSpecifierDeep(program, specifier, type) {
    const mut_stack = [type];
    // eslint-disable-next-line functional/no-loop-statements -- best to do this iteratively.
    while (mut_stack.length > 0) {
        const t = mut_stack.pop();
        if (typeMatchesSpecifier(program, specifier, t)) {
            return true;
        }
        if (t.aliasTypeArguments !== undefined) {
            mut_stack.push(...t.aliasTypeArguments);
        }
    }
    return false;
}

const typeSpecifierPatternSchemaProperties = {
    name: schemaInstanceOrInstanceArray({
        type: "string",
    }),
    pattern: schemaInstanceOrInstanceArray({
        type: "string",
    }),
    ignoreName: schemaInstanceOrInstanceArray({
        type: "string",
    }),
    ignorePattern: schemaInstanceOrInstanceArray({
        type: "string",
    }),
};
const typeSpecifierSchema = {
    oneOf: [
        {
            type: "object",
            properties: {
                ...typeSpecifierPatternSchemaProperties,
                from: {
                    type: "string",
                    enum: ["file"],
                },
                path: {
                    type: "string",
                },
            },
            additionalProperties: false,
        },
        {
            type: "object",
            properties: {
                ...typeSpecifierPatternSchemaProperties,
                from: {
                    type: "string",
                    enum: ["lib"],
                },
            },
            additionalProperties: false,
        },
        {
            type: "object",
            properties: {
                ...typeSpecifierPatternSchemaProperties,
                from: {
                    type: "string",
                    enum: ["package"],
                },
                package: {
                    type: "string",
                },
            },
            additionalProperties: false,
        },
    ],
};
function schemaInstanceOrInstanceArray(items) {
    return {
        oneOf: [
            items,
            {
                type: "array",
                items,
            },
        ],
    };
}
function overridableOptionsSchema(coreOptionsPropertiesSchema) {
    return {
        type: "object",
        properties: deepmerge(coreOptionsPropertiesSchema, {
            overrides: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        specifiers: schemaInstanceOrInstanceArray(typeSpecifierSchema),
                        options: {
                            type: "object",
                            properties: coreOptionsPropertiesSchema,
                            additionalProperties: false,
                        },
                        inherit: {
                            type: "boolean",
                        },
                        disable: {
                            type: "boolean",
                        },
                    },
                    additionalProperties: false,
                },
            },
        }),
        additionalProperties: false,
    };
}

/**
 * The name of this rule.
 */
const name$k = "functional-parameters";
/**
 * The full name of this rule.
 */
const fullName$a = `${ruleNameScope}/${name$k}`;
const coreOptionsPropertiesSchema$3 = deepmerge(ignoreIdentifierPatternOptionSchema, ignorePrefixSelectorOptionSchema, {
    allowRestParameter: {
        type: "boolean",
    },
    allowArgumentsKeyword: {
        type: "boolean",
    },
    enforceParameterCount: {
        oneOf: [
            {
                type: "boolean",
                enum: [false],
            },
            {
                type: "string",
                enum: ["atLeastOne", "exactlyOne"],
            },
            {
                type: "object",
                properties: {
                    count: {
                        type: "string",
                        enum: ["atLeastOne", "exactlyOne"],
                    },
                    ignoreGettersAndSetters: {
                        type: "boolean",
                    },
                    ignoreLambdaExpression: {
                        type: "boolean",
                    },
                    ignoreIIFE: {
                        type: "boolean",
                    },
                },
                additionalProperties: false,
            },
        ],
    },
});
/**
 * The schema for the rule options.
 */
const schema$k = [overridableOptionsSchema(coreOptionsPropertiesSchema$3)];
/**
 * The default options for the rule.
 */
const defaultOptions$k = [
    {
        allowRestParameter: false,
        allowArgumentsKeyword: false,
        enforceParameterCount: {
            count: "atLeastOne",
            ignoreLambdaExpression: false,
            ignoreIIFE: true,
            ignoreGettersAndSetters: true,
        },
    },
];
/**
 * The possible error messages.
 */
const errorMessages$k = {
    restParam: "Unexpected rest parameter. Use a regular parameter of type array instead.",
    arguments: "Unexpected use of `arguments`. Use regular function arguments instead.",
    paramCountAtLeastOne: "Functions must have at least one parameter.",
    paramCountExactlyOne: "Functions must have exactly one parameter.",
};
/**
 * The meta data for this rule.
 */
const meta$l = {
    type: "suggestion",
    docs: {
        category: "Currying",
        description: "Enforce functional parameters.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$k,
    schema: schema$k,
};
/**
 * Get the rest parameter violations.
 */
function getRestParamViolations({ allowRestParameter }, node) {
    return !allowRestParameter && node.params.length > 0 && isRestElement(node.params.at(-1))
        ? [
            {
                node: node.params.at(-1),
                messageId: "restParam",
            },
        ]
        : [];
}
/**
 * Get the parameter count violations.
 */
function getParamCountViolations({ enforceParameterCount }, node) {
    if (enforceParameterCount === false ||
        (node.params.length === 0 &&
            typeof enforceParameterCount === "object" &&
            ((enforceParameterCount.ignoreIIFE && isIIFE(node)) ||
                (enforceParameterCount.ignoreLambdaExpression && isArgument(node)) ||
                (enforceParameterCount.ignoreGettersAndSetters && (isGetter(node) || isSetter(node)))))) {
        return [];
    }
    if (node.params.length === 0 &&
        (enforceParameterCount === "atLeastOne" ||
            (typeof enforceParameterCount === "object" && enforceParameterCount.count === "atLeastOne"))) {
        return [
            {
                node,
                messageId: "paramCountAtLeastOne",
            },
        ];
    }
    if (node.params.length !== 1 &&
        (enforceParameterCount === "exactlyOne" ||
            (typeof enforceParameterCount === "object" && enforceParameterCount.count === "exactlyOne"))) {
        return [
            {
                node,
                messageId: "paramCountExactlyOne",
            },
        ];
    }
    return [];
}
/**
 * Add the default options to the given options.
 */
function getOptionsWithDefaults$3(options) {
    if (options === null) {
        return null;
    }
    const topLevel = {
        ...defaultOptions$k[0],
        ...options,
    };
    return typeof topLevel.enforceParameterCount === "object"
        ? {
            ...topLevel,
            enforceParameterCount: {
                ...defaultOptions$k[0].enforceParameterCount,
                ...topLevel.enforceParameterCount,
            },
        }
        : topLevel;
}
/**
 * Check if the given function node has a reset parameter this rule.
 */
function checkFunction$3(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const optionsToUse = getOptionsWithDefaults$3(getCoreOptions(node, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreIdentifierPattern } = optionsToUse;
    if (shouldIgnorePattern(node, context, ignoreIdentifierPattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: [...getRestParamViolations(optionsToUse, node), ...getParamCountViolations(optionsToUse, node)],
    };
}
/**
 * Check if the given identifier is for the "arguments" keyword.
 */
function checkIdentifier(node, context, rawOptions) {
    if (node.name !== "arguments") {
        return {
            context,
            descriptors: [],
        };
    }
    const functionNode = getEnclosingFunction(node);
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const optionsToUse = getOptionsWithDefaults$3(functionNode === null ? options : getCoreOptions(functionNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreIdentifierPattern } = optionsToUse;
    if (shouldIgnorePattern(node, context, ignoreIdentifierPattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    const { allowArgumentsKeyword } = optionsToUse;
    return {
        context,
        descriptors: !allowArgumentsKeyword && !isPropertyName(node) && !isPropertyAccess(node)
            ? [
                {
                    node,
                    messageId: "arguments",
                },
            ]
            : [],
    };
}
// Create the rule.
const rule$k = createRuleUsingFunction(name$k, meta$l, defaultOptions$k, (context, options) => {
    const [optionsObject] = options;
    const { ignorePrefixSelector } = optionsObject;
    const baseFunctionSelectors = ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"];
    const ignoreSelectors = ignorePrefixSelector === undefined
        ? undefined
        : Array.isArray(ignorePrefixSelector)
            ? ignorePrefixSelector
            : [ignorePrefixSelector];
    const fullFunctionSelectors = baseFunctionSelectors.flatMap((baseSelector) => ignoreSelectors === undefined ? [baseSelector] : `:not(:matches(${ignoreSelectors.join(",")})) > ${baseSelector}`);
    return {
        ...Object.fromEntries(fullFunctionSelectors.map((selector) => [selector, checkFunction$3])),
        Identifier: checkIdentifier,
    };
});

/**
 * The name of this rule.
 */
const name$j = "immutable-data";
/**
 * The full name of this rule.
 */
const fullName$9 = `${ruleNameScope}/${name$j}`;
const coreOptionsPropertiesSchema$2 = deepmerge(ignoreIdentifierPatternOptionSchema, ignoreAccessorPatternOptionSchema, ignoreClassesOptionSchema, ignoreMapsAndSetsOptionSchema, {
    ignoreImmediateMutation: {
        type: "boolean",
    },
    ignoreNonConstDeclarations: {
        oneOf: [
            {
                type: "boolean",
            },
            {
                type: "object",
                properties: {
                    treatParametersAsConst: {
                        type: "boolean",
                    },
                },
                additionalProperties: false,
            },
        ],
    },
});
/**
 * The schema for the rule options.
 */
const schema$j = [overridableOptionsSchema(coreOptionsPropertiesSchema$2)];
/**
 * The default options for the rule.
 */
const defaultOptions$j = [
    {
        ignoreClasses: false,
        ignoreMapsAndSets: false,
        ignoreImmediateMutation: true,
        ignoreNonConstDeclarations: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$j = {
    generic: "Modifying an existing object/array is not allowed.",
    object: "Modifying properties of existing object not allowed.",
    array: "Modifying an array is not allowed.",
    map: "Modifying a map is not allowed.",
    set: "Modifying a set is not allowed.",
};
/**
 * The meta data for this rule.
 */
const meta$k = {
    type: "suggestion",
    docs: {
        category: "No Mutations",
        description: "Enforce treating data as immutable.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$j,
    schema: schema$j,
};
/**
 * Array methods that mutate an array.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Methods#Mutator_methods
 */
const arrayMutatorMethods = new Set([
    "copyWithin",
    "fill",
    "pop",
    "push",
    "reverse",
    "shift",
    "sort",
    "splice",
    "unshift",
]);
/**
 * Array methods that return a new object (or array) without mutating the original.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Methods#Accessor_methods
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Iteration_methods
 */
const arrayNewObjectReturningMethods = new Set(["concat", "slice", "filter", "map", "reduce", "reduceRight"]);
/**
 * Array constructor functions that create a new array.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array#Methods
 */
const arrayConstructorFunctions = new Set(["from", "of"]);
/**
 * Map methods that mutate an map.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map
 */
const mapMutatorMethods = new Set(["clear", "delete", "set"]);
/**
 * Map methods that return a new object without mutating the original.
 */
const mapNewObjectReturningMethods = new Set([]);
/**
 * Set methods that mutate an set.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set
 */
const setMutatorMethods = new Set(["add", "clear", "delete"]);
/**
 * Set methods that return a new object without mutating the original.
 */
const setNewObjectReturningMethods = new Set(["difference", "intersection", "symmetricDifference", "union"]);
/**
 * Object constructor functions that mutate an object.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object#Methods_of_the_Object_constructor
 */
const objectConstructorMutatorFunctions = new Set(["assign", "defineProperties", "defineProperty", "setPrototypeOf"]);
/**
 * Object constructor functions that return new objects.
 */
const objectConstructorNewObjectReturningMethods = new Set([
    "create",
    "entries",
    "fromEntries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "groupBy",
    "keys",
    "values",
]);
/**
 * String constructor functions that return new objects.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String#Methods
 */
const stringConstructorNewObjectReturningMethods = new Set(["split"]);
/**
 * Check if the given assignment expression violates this rule.
 */
function checkAssignmentExpression$1(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const rootNode = findRootIdentifier(node.left) ?? node.left;
    const optionsToUse = getOptionsWithDefaults$2(getCoreOptions(rootNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreIdentifierPattern, ignoreAccessorPattern, ignoreNonConstDeclarations, ignoreClasses } = optionsToUse;
    if (!isMemberExpression(node.left) ||
        shouldIgnoreClasses(node, context, ignoreClasses) ||
        shouldIgnorePattern(node, context, ignoreIdentifierPattern, ignoreAccessorPattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    if (ignoreNonConstDeclarations !== false) {
        const rootIdentifier = findRootIdentifier(node.left.object);
        if (rootIdentifier !== undefined &&
            isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                !ignoreNonConstDeclarations.treatParametersAsConst ||
                shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
            return {
                context,
                descriptors: [],
            };
        }
    }
    return {
        context,
        descriptors: 
        // Allow if in a constructor - allow for field initialization.
        isInConstructor(node) ? [] : [{ node, messageId: "generic" }],
    };
}
/**
 * Check if the given node violates this rule.
 */
function checkUnaryExpression(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const rootNode = findRootIdentifier(node.argument) ?? node.argument;
    const optionsToUse = getOptionsWithDefaults$2(getCoreOptions(rootNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreIdentifierPattern, ignoreAccessorPattern, ignoreNonConstDeclarations, ignoreClasses } = optionsToUse;
    if (!isMemberExpression(node.argument) ||
        shouldIgnoreClasses(node, context, ignoreClasses) ||
        shouldIgnorePattern(node, context, ignoreIdentifierPattern, ignoreAccessorPattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    if (ignoreNonConstDeclarations !== false) {
        const rootIdentifier = findRootIdentifier(node.argument.object);
        if (rootIdentifier !== undefined &&
            isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                !ignoreNonConstDeclarations.treatParametersAsConst ||
                shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
            return {
                context,
                descriptors: [],
            };
        }
    }
    return {
        context,
        descriptors: node.operator === "delete" ? [{ node, messageId: "generic" }] : [],
    };
}
/**
 * Check if the given node violates this rule.
 */
function checkUpdateExpression(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const rootNode = findRootIdentifier(node.argument) ?? node.argument;
    const optionsToUse = getOptionsWithDefaults$2(getCoreOptions(rootNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreIdentifierPattern, ignoreAccessorPattern, ignoreNonConstDeclarations, ignoreClasses } = optionsToUse;
    if (!isMemberExpression(node.argument) ||
        shouldIgnoreClasses(node.argument, context, ignoreClasses) ||
        shouldIgnorePattern(node.argument, context, ignoreIdentifierPattern, ignoreAccessorPattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    if (ignoreNonConstDeclarations !== false) {
        const rootIdentifier = findRootIdentifier(node.argument.object);
        if (rootIdentifier !== undefined &&
            isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                !ignoreNonConstDeclarations.treatParametersAsConst ||
                shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
            return {
                context,
                descriptors: [],
            };
        }
    }
    return {
        context,
        descriptors: [{ node, messageId: "generic" }],
    };
}
/**
 * Check if the given the given MemberExpression is part of a chain and
 * immediately follows a method/function call that returns a new array.
 *
 * If this is the case, then the given MemberExpression is allowed to be
 * a mutator method call.
 */
function isInChainCallAndFollowsNew(node, context) {
    if (isMemberExpression(node)) {
        return isInChainCallAndFollowsNew(node.object, context);
    }
    if (isTSAsExpression(node)) {
        return isInChainCallAndFollowsNew(node.expression, context);
    }
    // Check for: [0, 1, 2]
    if (isArrayExpression(node)) {
        return true;
    }
    // Check for: new Array()
    if (isNewExpression(node)) {
        const type = getTypeOfNode(node.callee, context);
        return (isArrayConstructorType(context, type) ||
            isMapConstructorType(context, type) ||
            isSetConstructorType(context, type));
    }
    if (isCallExpression(node) && isMemberExpression(node.callee) && isIdentifier(node.callee.property)) {
        // Check for: Array.from(iterable)
        if (arrayConstructorFunctions.has(node.callee.property.name) &&
            isArrayConstructorType(context, getTypeOfNode(node.callee.object, context))) {
            return true;
        }
        // Check for: array.slice(0)
        if (arrayNewObjectReturningMethods.has(node.callee.property.name)) {
            return true;
        }
        if (mapNewObjectReturningMethods.has(node.callee.property.name)) {
            return true;
        }
        // Check for: set.difference(otherSet)
        if (setNewObjectReturningMethods.has(node.callee.property.name)) {
            return true;
        }
        // Check for: Object.entries(object)
        if (objectConstructorNewObjectReturningMethods.has(node.callee.property.name) &&
            isObjectConstructorType(context, getTypeOfNode(node.callee.object, context))) {
            return true;
        }
        // Check for: "".split("")
        if (stringConstructorNewObjectReturningMethods.has(node.callee.property.name) &&
            getTypeOfNode(node.callee.object, context).isStringLiteral()) {
            return true;
        }
    }
    return false;
}
/**
 * Add the default options to the given options.
 */
function getOptionsWithDefaults$2(options) {
    if (options === null) {
        return null;
    }
    return {
        ...defaultOptions$j[0],
        ...options,
    };
}
/**
 * Check if the given node violates this rule.
 */
function checkCallExpression$2(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const rootNode = findRootIdentifier(node.callee) ?? node.callee;
    const optionsToUse = getOptionsWithDefaults$2(getCoreOptions(rootNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreIdentifierPattern, ignoreAccessorPattern, ignoreNonConstDeclarations, ignoreClasses } = optionsToUse;
    // Not potential object mutation?
    if (!isMemberExpression(node.callee) ||
        !isIdentifier(node.callee.property) ||
        shouldIgnoreClasses(node.callee.object, context, ignoreClasses) ||
        shouldIgnorePattern(node.callee.object, context, ignoreIdentifierPattern, ignoreAccessorPattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreImmediateMutation, ignoreMapsAndSets } = optionsToUse;
    // Array mutation?
    if (arrayMutatorMethods.has(node.callee.property.name) &&
        (!ignoreImmediateMutation || !isInChainCallAndFollowsNew(node.callee, context)) &&
        isArrayType(context, getTypeOfNode(node.callee.object, context))) {
        if (ignoreNonConstDeclarations === false) {
            return {
                context,
                descriptors: [{ node, messageId: "array" }],
            };
        }
        const rootIdentifier = findRootIdentifier(node.callee.object);
        if (rootIdentifier === undefined ||
            !isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                !ignoreNonConstDeclarations.treatParametersAsConst ||
                shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
            return {
                context,
                descriptors: [{ node, messageId: "array" }],
            };
        }
    }
    if (!ignoreMapsAndSets) {
        // Set mutation?
        if (setMutatorMethods.has(node.callee.property.name) &&
            (!ignoreImmediateMutation || !isInChainCallAndFollowsNew(node.callee, context)) &&
            isSetType(context, getTypeOfNode(node.callee.object, context))) {
            if (ignoreNonConstDeclarations === false) {
                return {
                    context,
                    descriptors: [{ node, messageId: "set" }],
                };
            }
            const rootIdentifier = findRootIdentifier(node.callee.object);
            if (rootIdentifier === undefined ||
                !isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                    !ignoreNonConstDeclarations.treatParametersAsConst ||
                    shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
                return {
                    context,
                    descriptors: [{ node, messageId: "set" }],
                };
            }
        }
        // Map mutation?
        if (mapMutatorMethods.has(node.callee.property.name) &&
            (!ignoreImmediateMutation || !isInChainCallAndFollowsNew(node.callee, context)) &&
            isMapType(context, getTypeOfNode(node.callee.object, context))) {
            if (ignoreNonConstDeclarations === false) {
                return {
                    context,
                    descriptors: [{ node, messageId: "map" }],
                };
            }
            const rootIdentifier = findRootIdentifier(node.callee.object);
            if (rootIdentifier === undefined ||
                !isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                    !ignoreNonConstDeclarations.treatParametersAsConst ||
                    shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
                return {
                    context,
                    descriptors: [{ node, messageId: "map" }],
                };
            }
        }
    }
    // Non-array object mutation (ex. Object.assign on identifier)?
    if (objectConstructorMutatorFunctions.has(node.callee.property.name) &&
        node.arguments.length >= 2 &&
        (isIdentifier(node.arguments[0]) || isMemberExpression(node.arguments[0])) &&
        !shouldIgnoreClasses(node.arguments[0], context, ignoreClasses) &&
        !shouldIgnorePattern(node.arguments[0], context, ignoreIdentifierPattern, ignoreAccessorPattern) &&
        isObjectConstructorType(context, getTypeOfNode(node.callee.object, context))) {
        if (ignoreNonConstDeclarations === false) {
            return {
                context,
                descriptors: [{ node, messageId: "object" }],
            };
        }
        const rootIdentifier = findRootIdentifier(node.callee.object);
        if (rootIdentifier === undefined ||
            !isDefinedByMutableVariable(rootIdentifier, context, (variableNode) => ignoreNonConstDeclarations === true ||
                !ignoreNonConstDeclarations.treatParametersAsConst ||
                shouldIgnorePattern(variableNode, context, ignoreIdentifierPattern, ignoreAccessorPattern))) {
            return {
                context,
                descriptors: [{ node, messageId: "object" }],
            };
        }
    }
    return {
        context,
        descriptors: [],
    };
}
// Create the rule.
const rule$j = createRule(name$j, meta$k, defaultOptions$j, {
    AssignmentExpression: checkAssignmentExpression$1,
    UnaryExpression: checkUnaryExpression,
    UpdateExpression: checkUpdateExpression,
    CallExpression: checkCallExpression$2,
});

/**
 * The name of this rule.
 */
const name$i = "no-class-inheritance";
/**
 * The schema for the rule options.
 */
const schema$i = [
    {
        type: "object",
        properties: deepmerge(ignoreIdentifierPatternOptionSchema, ignoreCodePatternOptionSchema),
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$i = [{}];
/**
 * The possible error messages.
 */
const errorMessages$i = {
    abstract: "Unexpected abstract class.",
    extends: "Unexpected inheritance, use composition instead.",
};
/**
 * The meta data for this rule.
 */
const meta$j = {
    type: "suggestion",
    docs: {
        category: "No Other Paradigms",
        description: "Disallow inheritance in classes.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$i,
    schema: schema$i,
};
/**
 * Check if the given class node violates this rule.
 */
function checkClass$1(node, context, options) {
    const [optionsObject] = options;
    const { ignoreIdentifierPattern, ignoreCodePattern } = optionsObject;
    const mut_descriptors = [];
    if (!shouldIgnorePattern(node, context, ignoreIdentifierPattern, undefined, ignoreCodePattern)) {
        if (node.abstract) {
            const nodeText = context.sourceCode.getText(node);
            const abstractRelativeIndex = nodeText.indexOf("abstract");
            const abstractIndex = context.sourceCode.getIndexFromLoc(node.loc.start) + abstractRelativeIndex;
            const start = context.sourceCode.getLocFromIndex(abstractIndex);
            const end = context.sourceCode.getLocFromIndex(abstractIndex + "abstract".length);
            mut_descriptors.push({
                node,
                loc: {
                    start,
                    end,
                },
                messageId: "abstract",
            });
        }
        if (node.superClass !== null) {
            const nodeText = context.sourceCode.getText(node);
            const extendsRelativeIndex = nodeText.indexOf("extends");
            const extendsIndex = context.sourceCode.getIndexFromLoc(node.loc.start) + extendsRelativeIndex;
            const start = context.sourceCode.getLocFromIndex(extendsIndex);
            const { end } = node.superClass.loc;
            mut_descriptors.push({
                node,
                loc: {
                    start,
                    end,
                },
                messageId: "extends",
            });
        }
    }
    return {
        context,
        descriptors: mut_descriptors,
    };
}
// Create the rule.
const rule$i = createRule(name$i, meta$j, defaultOptions$i, {
    ClassDeclaration: checkClass$1,
    ClassExpression: checkClass$1,
});

/**
 * The name of this rule.
 */
const name$h = "no-classes";
/**
 * The full name of this rule.
 */
const fullName$8 = `${ruleNameScope}/${name$h}`;
/**
 * The schema for the rule options.
 */
const schema$h = [
    {
        type: "object",
        properties: deepmerge(ignoreIdentifierPatternOptionSchema, ignoreCodePatternOptionSchema),
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$h = [{}];
/**
 * The possible error messages.
 */
const errorMessages$h = {
    generic: "Unexpected class, use functions not classes.",
};
/**
 * The meta data for this rule.
 */
const meta$i = {
    type: "suggestion",
    docs: {
        category: "No Other Paradigms",
        description: "Disallow classes.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$h,
    schema: schema$h,
};
/**
 * Check if the given class node violates this rule.
 */
function checkClass(node, context, options) {
    const [optionsObject] = options;
    const { ignoreIdentifierPattern, ignoreCodePattern } = optionsObject;
    if (shouldIgnorePattern(node, context, ignoreIdentifierPattern, undefined, ignoreCodePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    return { context, descriptors: [{ node, messageId: "generic" }] };
}
// Create the rule.
const rule$h = createRule(name$h, meta$i, defaultOptions$h, {
    ClassDeclaration: checkClass,
    ClassExpression: checkClass,
});

const require = createRequire(import.meta.url);
var tsApiUtils = (typescript === undefined
    ? undefined
    : (() => {
        try {
            return require("ts-api-utils");
        }
        catch {
            return undefined;
        }
    })());
// export default (await (() => {
//   if (ts !== undefined) {
//     return import("ts-api-utils").catch(() => undefined);
//   }
//   return Promise.resolve(undefined);
// })()) as typeof tsApiUtils | undefined;

/**
 * The name of this .
 */
const name$g = "no-conditional-statements";
/**
 * The full name of this rule.
 */
const fullName$7 = `${ruleNameScope}/${name$g}`;
/**
 * The schema for the rule options.
 */
const schema$g = [
    {
        type: "object",
        properties: deepmerge(ignoreCodePatternOptionSchema, {
            allowReturningBranches: {
                oneOf: [
                    {
                        type: "boolean",
                    },
                    {
                        type: "string",
                        enum: ["ifExhaustive"],
                    },
                ],
            },
        }),
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$g = [{ allowReturningBranches: false }];
/**
 * The possible error messages.
 */
const errorMessages$g = {
    incompleteBranch: "Incomplete branch, every branch in a conditional statement must contain a return statement.",
    incompleteIf: "Incomplete if, it must have an else statement and every branch must contain a return statement.",
    incompleteSwitch: "Incomplete switch, it must be exhaustive or have an default case and every case must contain a return statement.",
    unexpectedIf: "Unexpected if, use a conditional expression (ternary operator) instead.",
    unexpectedSwitch: "Unexpected switch, use a conditional expression (ternary operator) instead.",
};
/**
 * The meta data for this rule.
 */
const meta$h = {
    type: "suggestion",
    docs: {
        category: "No Statements",
        description: "Disallow conditional statements.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$g,
    schema: schema$g,
};
/**
 * Report the given node as an incomplete branch violation.
 *
 * @param node - The node to report.
 * @returns A violation rule result.
 */
function incompleteBranchViolation(node) {
    return [{ node, messageId: "incompleteBranch" }];
}
/**
 * Get a function that tests if the given statement is never returning.
 */
function getIsNeverExpressions(context) {
    return (statement) => {
        if (isExpressionStatement(statement)) {
            const expressionStatementType = getTypeOfNode(statement.expression, context);
            return expressionStatementType !== null && tsApiUtils?.isIntrinsicNeverType(expressionStatementType) === true;
        }
        return false;
    };
}
/**
 * Is the given statement, when inside an if statement, a returning branch?
 */
function isIfReturningBranch(statement) {
    return (
    // Another instance of this rule will check nested if statements.
    isIfStatement(statement) ||
        isReturnStatement(statement) ||
        isThrowStatement(statement) ||
        isBreakStatement(statement) ||
        isContinueStatement(statement));
}
/**
 * Get all of the violations in the given if statement assuming if statements
 * are allowed.
 */
function getIfBranchViolations(node, context) {
    const branches = [node.consequent, node.alternate];
    const violations = branches.filter((branch) => {
        if (branch === null || isIfReturningBranch(branch)) {
            return false;
        }
        if (isExpressionStatement(branch)) {
            const expressionStatementType = getTypeOfNode(branch.expression, context);
            if (expressionStatementType !== null && tsApiUtils?.isIntrinsicNeverType(expressionStatementType) === true) {
                return false;
            }
        }
        if (isBlockStatement(branch)) {
            if (branch.body.some(isIfReturningBranch)) {
                return false;
            }
            const isNeverExpressions = getIsNeverExpressions(context);
            if (branch.body.some(isNeverExpressions)) {
                return false;
            }
        }
        return true;
    });
    return violations.flatMap(incompleteBranchViolation);
}
/**
 * Get all of the violations in the given switch statement assuming switch
 * statements are allowed.
 */
function getSwitchViolations(node, context) {
    const isNeverExpressions = getIsNeverExpressions(context);
    const label = isLabeledStatement(node.parent) ? node.parent.label.name : null;
    const violations = node.cases.filter((branch) => {
        if (branch.consequent.length === 0) {
            return false;
        }
        if (branch.consequent.some(isSwitchReturningBranch)) {
            return false;
        }
        if (branch.consequent.every(isBlockStatement)) {
            const lastBlock = branch.consequent.at(-1);
            if (lastBlock.body.some(isSwitchReturningBranch)) {
                return false;
            }
            if (lastBlock.body.some(isNeverExpressions)) {
                return false;
            }
        }
        return !branch.consequent.some(isNeverExpressions);
    });
    return violations.flatMap(incompleteBranchViolation);
    /**
     * Is the given statement, when inside a switch statement, a returning branch?
     */
    function isSwitchReturningBranch(statement) {
        return (
        // Another instance of this rule will check nested switch statements.
        isSwitchStatement(statement) ||
            isReturnStatement(statement) ||
            isThrowStatement(statement) ||
            (isBreakStatement(statement) && statement.label !== null && statement.label.name !== label) ||
            isContinueStatement(statement));
    }
}
/**
 * Does the given if statement violate this rule if it must be exhaustive.
 */
function isExhaustiveIfViolation(node) {
    return node.alternate === null;
}
/**
 * Does the given typed switch statement violate this rule if it must be exhaustive.
 */
function isExhaustiveTypeSwitchViolation(node, context) {
    const discriminantType = getTypeOfNode(node.discriminant, context);
    if (!discriminantType?.isUnion()) {
        return true;
    }
    const caseTypes = node.cases.reduce((types, c) => new Set([...types, getTypeOfNode(c.test, context)]), new Set());
    return discriminantType.types.some((unionType) => !caseTypes.has(unionType));
}
/**
 * Does the given switch statement violate this rule if it must be exhaustive.
 */
function isExhaustiveSwitchViolation(node, context) {
    return (
    // No cases defined.
    node.cases.every((c) => c.test !== null) ? isExhaustiveTypeSwitchViolation(node, context) : false);
}
/**
 * Check if the given IfStatement violates this rule.
 */
function checkIfStatement(node, context, options) {
    const [{ allowReturningBranches, ignoreCodePattern }] = options;
    if (shouldIgnorePattern(node.test, context, undefined, undefined, ignoreCodePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: allowReturningBranches === false
            ? [{ node, messageId: "unexpectedIf" }]
            : allowReturningBranches === "ifExhaustive"
                ? isExhaustiveIfViolation(node)
                    ? [{ node, messageId: "incompleteIf" }]
                    : getIfBranchViolations(node, context)
                : getIfBranchViolations(node, context),
    };
}
/**
 * Check if the given SwitchStatement violates this rule.
 */
function checkSwitchStatement(node, context, options) {
    const [{ allowReturningBranches }] = options;
    return {
        context,
        descriptors: allowReturningBranches === false
            ? [{ node, messageId: "unexpectedSwitch" }]
            : allowReturningBranches === "ifExhaustive"
                ? isExhaustiveSwitchViolation(node, context)
                    ? [{ node, messageId: "incompleteSwitch" }]
                    : getSwitchViolations(node, context)
                : getSwitchViolations(node, context),
    };
}
// Create the rule.
const rule$g = createRule(name$g, meta$h, defaultOptions$g, {
    IfStatement: checkIfStatement,
    SwitchStatement: checkSwitchStatement,
});

/**
 * The name of this rule.
 */
const name$f = "no-expression-statements";
/**
 * The full name of this rule.
 */
const fullName$6 = `${ruleNameScope}/${name$f}`;
/**
 * The schema for the rule options.
 */
const schema$f = [
    {
        type: "object",
        properties: deepmerge(ignoreCodePatternOptionSchema, {
            ignoreVoid: {
                type: "boolean",
            },
            ignoreNever: {
                type: "boolean",
            },
            ignoreSelfReturning: {
                type: "boolean",
            },
        }),
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$f = [
    {
        ignoreVoid: false,
        ignoreNever: false,
        ignoreSelfReturning: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$f = {
    generic: "Using expressions to cause side-effects not allowed.",
};
/**
 * The meta data for this rule.
 */
const meta$g = {
    type: "suggestion",
    docs: {
        category: "No Statements",
        description: "Disallow expression statements.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$f,
    schema: schema$f,
};
/**
 * Check if the given ExpressionStatement violates this rule.
 */
function checkExpressionStatement(node, context, options) {
    const [optionsObject] = options;
    const { ignoreCodePattern } = optionsObject;
    if (shouldIgnorePattern(node, context, undefined, undefined, ignoreCodePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    // Allow specifying directive prologues and using yield expressions.
    if (isDirectivePrologue(node) || isYieldExpression(node.expression)) {
        return {
            context,
            descriptors: [],
        };
    }
    const { ignoreVoid, ignoreNever, ignoreSelfReturning } = optionsObject;
    if ((ignoreVoid || ignoreNever || ignoreSelfReturning) && isCallExpression(node.expression)) {
        const returnType = getTypeOfNode(node.expression, context);
        if (returnType === null) {
            return {
                context,
                descriptors: [{ node, messageId: "generic" }],
            };
        }
        if (ignoreVoid &&
            (tsApiUtils?.isIntrinsicVoidType(returnType) === true ||
                ("typeArguments" in returnType &&
                    isPromiseType(context, returnType) &&
                    returnType.typeArguments.length > 0 &&
                    tsApiUtils?.isIntrinsicVoidType(returnType.typeArguments[0]) === true))) {
            return {
                context,
                descriptors: [],
            };
        }
        if (ignoreNever &&
            (tsApiUtils?.isIntrinsicNeverType(returnType) === true ||
                ("typeArguments" in returnType &&
                    isPromiseType(context, returnType) &&
                    returnType.typeArguments.length > 0 &&
                    tsApiUtils?.isIntrinsicNeverType(returnType.typeArguments[0]) === true))) {
            return {
                context,
                descriptors: [],
            };
        }
        if (ignoreSelfReturning) {
            const type = getTypeOfNode(node.expression.callee, context);
            if (type !== null) {
                const declaration = type.getSymbol()?.valueDeclaration;
                if (typescript !== undefined &&
                    declaration !== undefined &&
                    typescript.isFunctionLike(declaration) &&
                    !typescript.isArrowFunction(declaration) &&
                    "body" in declaration &&
                    declaration.body !== undefined &&
                    typescript.isBlock(declaration.body)) {
                    const returnStatements = declaration.body.statements.filter(typescript.isReturnStatement);
                    if (returnStatements.every((statement) => statement.expression !== undefined && tsApiUtils?.isThisKeyword(statement.expression) === true)) {
                        return {
                            context,
                            descriptors: [],
                        };
                    }
                }
            }
        }
    }
    return {
        context,
        descriptors: [{ node, messageId: "generic" }],
    };
}
// Create the rule.
const rule$f = createRule(name$f, meta$g, defaultOptions$f, {
    ExpressionStatement: checkExpressionStatement,
});

/**
 * The name of this rule.
 */
const name$e = "no-let";
/**
 * The full name of this rule.
 */
const fullName$5 = `${ruleNameScope}/${name$e}`;
/**
 * The schema for the rule options.
 */
const schema$e = [
    {
        type: "object",
        properties: deepmerge(ignoreIdentifierPatternOptionSchema, {
            allowInForLoopInit: {
                type: "boolean",
            },
            allowInFunctions: {
                type: "boolean",
            },
        }),
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$e = [
    {
        allowInForLoopInit: false,
        allowInFunctions: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$e = {
    generic: "Unexpected let, use const instead.",
};
/**
 * The meta data for this rule.
 */
const meta$f = {
    type: "suggestion",
    docs: {
        category: "No Mutations",
        description: "Disallow mutable variables.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$e,
    schema: schema$e,
};
/**
 * Check if the given VariableDeclaration violates this rule.
 */
function checkVariableDeclaration$1(node, context, options) {
    const [optionsObject] = options;
    const { allowInForLoopInit, ignoreIdentifierPattern, allowInFunctions } = optionsObject;
    if (node.kind !== "let" ||
        shouldIgnoreInFunction(node, context, allowInFunctions) ||
        shouldIgnorePattern(node, context, ignoreIdentifierPattern) ||
        (allowInForLoopInit && isInForLoopInitializer(node))) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: [{ node, messageId: "generic" }],
    };
}
// Create the rule.
const rule$e = createRule(name$e, meta$f, defaultOptions$e, {
    VariableDeclaration: checkVariableDeclaration$1,
});

/**
 * The name of this rule.
 */
const name$d = "no-loop-statements";
/**
 * The schema for the rule options.
 */
const schema$d = [];
/**
 * The default options for the rule.
 */
const defaultOptions$d = [{}];
/**
 * The possible error messages.
 */
const errorMessages$d = {
    generic: "Unexpected loop, use map or reduce instead.",
};
/**
 * The meta data for this rule.
 */
const meta$e = {
    type: "suggestion",
    docs: {
        category: "No Statements",
        description: "Disallow imperative loops.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$d,
    schema: schema$d,
};
/**
 * Check if the given loop violates this rule.
 */
function checkLoop(node, context) {
    // All loops violate this rule.
    return { context, descriptors: [{ node, messageId: "generic" }] };
}
// Create the rule.
const rule$d = createRule(name$d, meta$e, defaultOptions$d, {
    ForStatement: checkLoop,
    ForInStatement: checkLoop,
    ForOfStatement: checkLoop,
    WhileStatement: checkLoop,
    DoWhileStatement: checkLoop,
});

/**
 * The name of this rule.
 */
const name$c = "no-mixed-types";
/**
 * The schema for the rule options.
 */
const schema$c = [
    {
        type: "object",
        properties: {
            checkInterfaces: {
                type: "boolean",
            },
            checkTypeLiterals: {
                type: "boolean",
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$c = [
    {
        checkInterfaces: true,
        checkTypeLiterals: true,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$c = {
    generic: "Only the same kind of members allowed in types.",
};
/**
 * The meta data for this rule.
 */
const meta$d = {
    type: "suggestion",
    docs: {
        category: "No Other Paradigms",
        description: "Restrict types so that only members of the same kind are allowed in them.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$c,
    schema: schema$c,
};
/**
 * Does the given type elements violate the rule.
 */
function hasTypeElementViolations(typeElements, context) {
    return !typeElements
        .map((member) => isTSMethodSignature(member) ||
        isTSCallSignatureDeclaration(member) ||
        isTSConstructSignatureDeclaration(member) ||
        ((isTSPropertySignature(member) || isTSIndexSignature(member)) &&
            member.typeAnnotation !== undefined &&
            (isTSFunctionType(member.typeAnnotation.typeAnnotation) ||
                isFunctionLikeType(getTypeOfNode(member, context)))))
        .every((isFunction, _, array) => array[0] === isFunction);
}
/**
 * Check if the given TSInterfaceDeclaration violates this rule.
 */
function checkTSInterfaceDeclaration(node, context, options) {
    return {
        context,
        descriptors: hasTypeElementViolations(node.body.body, context) ? [{ node, messageId: "generic" }] : [],
    };
}
/**
 * Check if the given TSTypeAliasDeclaration violates this rule.
 */
function checkTSTypeAliasDeclaration(node, context, options) {
    return {
        context,
        descriptors: 
        // TypeLiteral.
        (isTSTypeLiteral(node.typeAnnotation) && hasTypeElementViolations(node.typeAnnotation.members, context)) ||
            // TypeLiteral inside `Readonly<>`.
            (isTSTypeReference(node.typeAnnotation) &&
                isIdentifier(node.typeAnnotation.typeName) &&
                node.typeAnnotation.typeArguments !== undefined &&
                node.typeAnnotation.typeArguments.params.length === 1 &&
                isTSTypeLiteral(node.typeAnnotation.typeArguments.params[0]) &&
                hasTypeElementViolations(node.typeAnnotation.typeArguments.params[0].members, context))
            ? [{ node, messageId: "generic" }]
            : [],
    };
}
// Create the rule.
const rule$c = createRuleUsingFunction(name$c, meta$d, defaultOptions$c, (context, options) => {
    const [{ checkInterfaces, checkTypeLiterals }] = options;
    return Object.fromEntries([
        ["TSInterfaceDeclaration", checkInterfaces ? checkTSInterfaceDeclaration : undefined],
        ["TSTypeAliasDeclaration", checkTypeLiterals ? checkTSTypeAliasDeclaration : undefined],
    ].filter(([sel, fn]) => fn !== undefined));
});

/**
 * The name of this rule.
 */
const name$b = "no-promise-reject";
/**
 * The schema for the rule options.
 */
const schema$b = [];
/**
 * The default options for the rule.
 */
const defaultOptions$b = [{}];
/**
 * The possible error messages.
 */
const errorMessages$b = {
    generic: "Unexpected rejection, resolve an error instead.",
};
/**
 * The meta data for this rule.
 */
const meta$c = {
    type: "suggestion",
    docs: {
        category: "No Exceptions",
        description: "Disallow rejecting promises.",
        recommended: false,
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$b,
    schema: schema$b,
};
/**
 * Check if the given CallExpression violates this rule.
 */
function checkCallExpression$1(node, context) {
    return {
        context,
        descriptors: 
        // TODO: Better Promise type detection.
        isMemberExpression(node.callee) &&
            isIdentifier(node.callee.object) &&
            isIdentifier(node.callee.property) &&
            node.callee.object.name === "Promise" &&
            node.callee.property.name === "reject"
            ? [{ node, messageId: "generic" }]
            : [],
    };
}
/**
 * Check if the given NewExpression is for a Promise and it has a callback that rejects.
 */
function checkNewExpression(node, context) {
    return {
        context,
        descriptors: 
        // TODO: Better Promise type detection.
        isIdentifier(node.callee) &&
            node.callee.name === "Promise" &&
            node.arguments[0] !== undefined &&
            isFunctionLike(node.arguments[0]) &&
            node.arguments[0].params.length === 2
            ? [{ node: node.arguments[0].params[1], messageId: "generic" }]
            : [],
    };
}
/**
 * Check if the given ThrowStatement violates this rule.
 */
function checkThrowStatement$1(node, context) {
    const enclosingFunction = getEnclosingFunction(node);
    if (enclosingFunction?.async !== true) {
        return { context, descriptors: [] };
    }
    const enclosingTryStatement = getEnclosingTryStatement(node);
    if (enclosingTryStatement === null ||
        getEnclosingFunction(enclosingTryStatement) !== enclosingFunction ||
        enclosingTryStatement.handler === null) {
        return {
            context,
            descriptors: [{ node, messageId: "generic" }],
        };
    }
    return {
        context,
        descriptors: [],
    };
}
// Create the rule.
const rule$b = createRule(name$b, meta$c, defaultOptions$b, {
    CallExpression: checkCallExpression$1,
    NewExpression: checkNewExpression,
    ThrowStatement: checkThrowStatement$1,
});

/**
 * The name of this rule.
 */
const name$a = "no-return-void";
/**
 * The schema for the rule options.
 */
const schema$a = [
    {
        type: "object",
        properties: {
            allowNull: {
                type: "boolean",
            },
            allowUndefined: {
                type: "boolean",
            },
            ignoreInferredTypes: {
                type: "boolean",
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$a = [
    {
        allowNull: true,
        allowUndefined: true,
        ignoreInferredTypes: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$a = {
    generic: "Function must return a value.",
};
/**
 * The meta data for this rule.
 */
const meta$b = {
    type: "suggestion",
    docs: {
        category: "No Statements",
        description: "Disallow functions that don't return anything.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$a,
    schema: schema$a,
};
/**
 * Check if the given function node violates this rule.
 */
function checkFunction$2(node, context, options) {
    const [{ ignoreInferredTypes, allowNull, allowUndefined }] = options;
    if (node.returnType === undefined) {
        if (!ignoreInferredTypes && isFunctionLike(node)) {
            const functionType = getTypeOfNode(node, context);
            const returnType = functionType?.getCallSignatures()?.[0]?.getReturnType();
            if (returnType !== undefined &&
                tsApiUtils !== undefined &&
                (tsApiUtils.isIntrinsicVoidType(returnType) ||
                    (!allowNull && tsApiUtils.isIntrinsicNullType(returnType)) ||
                    (!allowUndefined && tsApiUtils.isIntrinsicUndefinedType(returnType)))) {
                return {
                    context,
                    descriptors: [{ node, messageId: "generic" }],
                };
            }
        }
    }
    else if (isTSVoidKeyword(node.returnType.typeAnnotation) ||
        (!allowNull && isTSNullKeyword(node.returnType.typeAnnotation)) ||
        (!allowUndefined && isTSUndefinedKeyword(node.returnType.typeAnnotation))) {
        return {
            context,
            descriptors: [{ node: node.returnType, messageId: "generic" }],
        };
    }
    return {
        context,
        descriptors: [],
    };
}
// Create the rule.
const rule$a = createRule(name$a, meta$b, defaultOptions$a, {
    ArrowFunctionExpression: checkFunction$2,
    FunctionDeclaration: checkFunction$2,
    FunctionExpression: checkFunction$2,
    TSCallSignatureDeclaration: checkFunction$2,
    TSConstructSignatureDeclaration: checkFunction$2,
    TSDeclareFunction: checkFunction$2,
    TSEmptyBodyFunctionExpression: checkFunction$2,
    TSFunctionType: checkFunction$2,
    TSMethodSignature: checkFunction$2,
});

/**
 * The name of this rule.
 */
const name$9 = "no-this-expressions";
/**
 * The full name of this rule.
 */
const fullName$4 = `${ruleNameScope}/${name$9}`;
/**
 * The schema for the rule options.
 */
const schema$9 = [];
/**
 * The default options for the rule.
 */
const defaultOptions$9 = [{}];
/**
 * The possible error messages.
 */
const errorMessages$9 = {
    generic: "Unexpected this, use functions not classes.",
};
/**
 * The meta data for this rule.
 */
const meta$a = {
    type: "suggestion",
    docs: {
        category: "No Other Paradigms",
        description: "Disallow this access.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$9,
    schema: schema$9,
};
/**
 * Check if the given ThisExpression violates this rule.
 */
function checkThisExpression(node, context) {
    // All throw statements violate this rule.
    return { context, descriptors: [{ node, messageId: "generic" }] };
}
// Create the rule.
const rule$9 = createRule(name$9, meta$a, defaultOptions$9, {
    ThisExpression: checkThisExpression,
});

/**
 * The name of this rule.
 */
const name$8 = "no-throw-statements";
/**
 * The full name of this rule.
 */
const fullName$3 = `${ruleNameScope}/${name$8}`;
/**
 * The schema for the rule options.
 */
const schema$8 = [
    {
        type: "object",
        properties: {
            allowToRejectPromises: {
                type: "boolean",
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$8 = [
    {
        allowToRejectPromises: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$8 = {
    generic: "Unexpected throw, throwing exceptions is not functional.",
};
/**
 * The meta data for this rule.
 */
const meta$9 = {
    type: "suggestion",
    docs: {
        category: "No Exceptions",
        description: "Disallow throwing exceptions.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$8,
    schema: schema$8,
};
/**
 * Check if the given ThrowStatement violates this rule.
 */
function checkThrowStatement(node, context, options) {
    const [{ allowToRejectPromises }] = options;
    if (!allowToRejectPromises) {
        return { context, descriptors: [{ node, messageId: "generic" }] };
    }
    if (isInPromiseHandlerFunction(node, context)) {
        return { context, descriptors: [] };
    }
    const enclosingFunction = getEnclosingFunction(node);
    if (enclosingFunction?.async !== true) {
        return { context, descriptors: [{ node, messageId: "generic" }] };
    }
    const enclosingTryStatement = getEnclosingTryStatement(node);
    if (!(enclosingTryStatement === null ||
        getEnclosingFunction(enclosingTryStatement) !== enclosingFunction ||
        enclosingTryStatement.handler === null)) {
        return { context, descriptors: [{ node, messageId: "generic" }] };
    }
    return {
        context,
        descriptors: [],
    };
}
// Create the rule.
const rule$8 = createRule(name$8, meta$9, defaultOptions$8, {
    ThrowStatement: checkThrowStatement,
});

/**
 * The name of this rule.
 */
const name$7 = "no-try-statements";
/**
 * The full name of this rule.
 */
const fullName$2 = `${ruleNameScope}/${name$7}`;
/**
 * The schema for the rule options.
 */
const schema$7 = [
    {
        type: "object",
        properties: {
            allowCatch: {
                type: "boolean",
            },
            allowFinally: {
                type: "boolean",
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$7 = [
    {
        allowCatch: false,
        allowFinally: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$7 = {
    catch: "Unexpected try-catch, this pattern is not functional.",
    finally: "Unexpected try-finally, this pattern is not functional.",
};
/**
 * The meta data for this rule.
 */
const meta$8 = {
    type: "suggestion",
    docs: {
        category: "No Exceptions",
        description: "Disallow try-catch[-finally] and try-finally patterns.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: false,
    },
    messages: errorMessages$7,
    schema: schema$7,
};
/**
 * Check if the given TryStatement violates this rule.
 */
function checkTryStatement(node, context, options) {
    const [{ allowCatch, allowFinally }] = options;
    return {
        context,
        descriptors: !allowCatch && node.handler !== null
            ? [{ node, messageId: "catch" }]
            : !allowFinally && node.finalizer !== null
                ? [{ node, messageId: "finally" }]
                : [],
    };
}
// Create the rule.
const rule$7 = createRule(name$7, meta$8, defaultOptions$7, {
    TryStatement: checkTryStatement,
});

/**
 * The name of this rule.
 */
const name$6 = "prefer-immutable-types";
/**
 * The full name of this rule.
 */
const fullName$1 = `${ruleNameScope}/${name$6}`;
/**
 * The enum options for the level of enforcement.
 */
const enforcementEnumOptions = [
    ...Object.values(Immutability).filter((i) => i !== Immutability.Unknown &&
        i !== Immutability[Immutability.Unknown] &&
        i !== Immutability.Mutable &&
        i !== Immutability[Immutability.Mutable]),
    "None",
    false,
];
/**
 * The non-shorthand schema for each option.
 */
const optionExpandedSchema = deepmerge(ignoreClassesOptionSchema, {
    enforcement: {
        type: ["string", "number", "boolean"],
        enum: enforcementEnumOptions,
    },
    ignoreInferredTypes: {
        type: "boolean",
    },
    ignoreNamePattern: {
        type: ["string", "array"],
        items: {
            type: "string",
        },
    },
    ignoreTypePattern: {
        type: ["string", "array"],
        items: {
            type: "string",
        },
    },
});
/**
 * The schema for each option.
 */
const optionSchema = {
    oneOf: [
        {
            type: "object",
            properties: optionExpandedSchema,
            additionalProperties: false,
        },
        {
            type: ["string", "number", "boolean"],
            enum: enforcementEnumOptions,
        },
    ],
};
/**
 * The schema for each fixer config.
 */
const fixerSchema$1 = {
    oneOf: [
        {
            type: "object",
            properties: {
                pattern: { type: "string" },
                replace: { type: "string" },
            },
            additionalProperties: false,
        },
        {
            type: "array",
            items: {
                type: "object",
                properties: {
                    pattern: { type: "string" },
                    replace: { type: "string" },
                },
                additionalProperties: false,
            },
        },
    ],
};
const suggestionsSchema$1 = {
    type: "array",
    items: {
        type: "array",
        items: {
            type: "object",
            properties: {
                pattern: { type: "string" },
                replace: { type: "string" },
                message: { type: "string" },
            },
            additionalProperties: false,
        },
    },
};
const coreOptionsPropertiesSchema$1 = deepmerge(optionExpandedSchema, {
    parameters: optionSchema,
    returnTypes: optionSchema,
    variables: {
        oneOf: [
            {
                type: "object",
                properties: deepmerge(optionExpandedSchema, {
                    ignoreInFunctions: {
                        type: "boolean",
                    },
                }),
                additionalProperties: false,
            },
            {
                type: ["string", "number", "boolean"],
                enum: enforcementEnumOptions,
            },
        ],
    },
    fixer: {
        type: "object",
        properties: {
            ReadonlyShallow: fixerSchema$1,
            ReadonlyDeep: fixerSchema$1,
            Immutable: fixerSchema$1,
        },
        additionalProperties: false,
    },
    suggestions: {
        type: "object",
        properties: {
            ReadonlyShallow: suggestionsSchema$1,
            ReadonlyDeep: suggestionsSchema$1,
            Immutable: suggestionsSchema$1,
        },
        additionalProperties: false,
    },
});
/**
 * The schema for the rule options.
 */
const schema$6 = [overridableOptionsSchema(coreOptionsPropertiesSchema$1)];
/**
 * The default options for the rule.
 */
const defaultOptions$6 = [
    {
        enforcement: Immutability.Immutable,
        ignoreInferredTypes: false,
        ignoreClasses: false,
        suggestions: {
            ReadonlyShallow: [
                [
                    {
                        pattern: "^([_$a-zA-Z\\xA0-\\uFFFF][_$a-zA-Z0-9\\xA0-\\uFFFF]*\\[\\])$",
                        replace: "readonly $1",
                        message: "Prepend with readonly.",
                    },
                    {
                        pattern: "^(Array|Map|Set)<(.+)>$",
                        replace: "Readonly$1<$2>",
                        message: "Use Readonly$1 instead of $1.",
                    },
                ],
                [
                    {
                        pattern: "^(.+)$",
                        replace: "Readonly<$1>",
                        message: "Surround with Readonly.",
                    },
                ],
            ],
        },
    },
];
/**
 * The possible error messages.
 */
const errorMessages$6 = {
    parameter: 'Parameter should have an immutability of at least "{{ expected }}" (actual: "{{ actual }}").',
    returnType: 'Return type should have an immutability of at least "{{ expected }}" (actual: "{{ actual }}").',
    variable: 'Variable should have an immutability of at least "{{ expected }}" (actual: "{{ actual }}").',
    propertyImmutability: 'Property should have an immutability of at least "{{ expected }}" (actual: "{{ actual }}").',
    propertyModifier: "Property should have a readonly modifier.",
    propertyModifierSuggestion: "Add readonly modifier.",
    userDefined: "{{ message }}",
};
/**
 * The meta data for this rule.
 */
const meta$7 = {
    type: "suggestion",
    docs: {
        category: "No Mutations",
        description: "Require function parameters to be typed as certain immutability",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    fixable: "code",
    hasSuggestions: true,
    messages: errorMessages$6,
    schema: schema$6,
};
/**
 * Get the fixer and the suggestions' fixers.
 */
function getAllFixers(node, context, fixerConfigs, suggestionsConfigs) {
    const nodeText = context.sourceCode.getText(node).replaceAll(/\s+/gu, " ");
    const fix = fixerConfigs === false ? null : getConfiguredFixer$1(node, nodeText, fixerConfigs);
    const suggestionFixers = suggestionsConfigs === false ? null : getConfiguredSuggestionFixers(node, nodeText, suggestionsConfigs);
    return { fix, suggestionFixers };
}
/**
 * Get a fixer that uses the user config.
 */
function getConfiguredFixer$1(node, text, configs) {
    const config = configs.find((c) => c.pattern.test(text));
    if (config === undefined) {
        return null;
    }
    return (fixer) => fixer.replaceText(node, text.replace(config.pattern, config.replace));
}
/**
 * Get a fixer that uses the user config.
 */
function getConfiguredSuggestionFixers(node, text, suggestionsConfigs) {
    return suggestionsConfigs
        .map((configs) => {
        const config = configs.find((c) => c.pattern.test(text));
        if (config === undefined) {
            return null;
        }
        return {
            fix: (fixer) => fixer.replaceText(node, text.replace(config.pattern, config.replace)),
            message: config.message === undefined
                ? `Replace with: ${text.replace(config.pattern, config.replace)}`
                : text.replace(config.pattern, config.message),
        };
    })
        .filter(isDefined);
}
/**
 * Get the level of enforcement from the raw value given.
 */
function parseEnforcement(rawEnforcement) {
    return rawEnforcement === "None" || rawEnforcement === undefined
        ? false
        : typeof rawEnforcement === "string"
            ? Immutability[rawEnforcement]
            : rawEnforcement;
}
/**
 * Get the fixer config for the the given enforcement level from the raw config given.
 */
function parseFixerConfigs(allRawConfigs, enforcement) {
    const key = Immutability[enforcement];
    const rawConfigs = allRawConfigs?.[key];
    if (rawConfigs === undefined) {
        return false;
    }
    const raws = Array.isArray(rawConfigs) ? rawConfigs : [rawConfigs];
    return raws.map((r) => ({
        ...r,
        pattern: new RegExp(r.pattern, "u"),
    }));
}
/**
 * Get the suggestions config for the the given enforcement level from the raw config given.
 */
function parseSuggestionsConfigs(rawSuggestions, enforcement) {
    const key = Immutability[enforcement];
    const rawConfigsSet = rawSuggestions?.[key];
    if (rawConfigsSet === undefined) {
        return false;
    }
    return rawConfigsSet.map((rawConfigs) => rawConfigs.map((rawConfig) => ({
        ...rawConfig,
        pattern: new RegExp(rawConfig.pattern, "u"),
    })));
}
/**
 * Get the parameter type violations.
 */
function getParameterTypeViolations(node, context, options) {
    return node.params
        .map((param) => {
        const parameterProperty = isTSParameterProperty(param);
        const actualParam = parameterProperty ? param.parameter : param;
        const optionsToUse = getOptionsWithDefaults$1(getCoreOptions(param, context, options));
        if (optionsToUse === null) {
            return undefined;
        }
        const { parameters: rawOption, fixer: rawFixerConfig, suggestions: rawSuggestionsConfigs } = optionsToUse;
        const { enforcement: rawEnforcement, ignoreInferredTypes, ignoreClasses, ignoreNamePattern, ignoreTypePattern, } = {
            ignoreInferredTypes: optionsToUse.ignoreInferredTypes,
            ignoreClasses: optionsToUse.ignoreClasses,
            ignoreNamePattern: optionsToUse.ignoreNamePattern,
            ignoreTypePattern: optionsToUse.ignoreTypePattern,
            ...(typeof rawOption === "object"
                ? rawOption
                : {
                    enforcement: rawOption,
                }),
        };
        const enforcement = parseEnforcement(rawEnforcement ?? optionsToUse.enforcement);
        if (enforcement === false || shouldIgnoreClasses(node, context, ignoreClasses)) {
            return undefined;
        }
        const fixerConfigs = parseFixerConfigs(rawFixerConfig, enforcement);
        const suggestionsConfigs = parseSuggestionsConfigs(rawSuggestionsConfigs, enforcement);
        if (shouldIgnorePattern(param, context, ignoreNamePattern)) {
            return undefined;
        }
        if (parameterProperty && !param.readonly) {
            const fix = (fixer) => fixer.insertTextBefore(param.parameter, "readonly ");
            return {
                node: param,
                messageId: "propertyModifier",
                fix: fixerConfigs === false ? null : fix,
                suggest: [
                    {
                        messageId: "propertyModifierSuggestion",
                        fix,
                    },
                ],
            };
        }
        if (
        // inferred types
        (ignoreInferredTypes && actualParam.typeAnnotation === undefined) ||
            // ignored
            (actualParam.typeAnnotation !== undefined &&
                shouldIgnorePattern(actualParam.typeAnnotation, context, ignoreTypePattern)) ||
            // type guard
            (node.returnType !== undefined &&
                isTSTypePredicate(node.returnType.typeAnnotation) &&
                isIdentifier(node.returnType.typeAnnotation.parameterName) &&
                isIdentifier(actualParam) &&
                actualParam.name === node.returnType.typeAnnotation.parameterName.name)) {
            return undefined;
        }
        const immutability = getTypeImmutabilityOfNode(actualParam, context, enforcement);
        if (immutability >= enforcement) {
            return undefined;
        }
        const { fix, suggestionFixers } = actualParam.typeAnnotation === undefined
            ? {}
            : getAllFixers(actualParam.typeAnnotation.typeAnnotation, context, fixerConfigs, suggestionsConfigs);
        return {
            node: actualParam,
            messageId: "parameter",
            data: {
                actual: Immutability[immutability],
                expected: Immutability[enforcement],
            },
            fix,
            suggest: suggestionFixers?.map(({ fix, message }) => ({
                messageId: "userDefined",
                data: {
                    message,
                },
                fix,
            })) ?? null,
        };
    })
        .filter(isDefined);
}
/**
 * Get the return type violations.
 */
function getReturnTypeViolations(node, context, options) {
    function getOptions(type, typeNode) {
        const optionsToUse = getOptionsWithDefaults$1(getCoreOptionsForType(type, typeNode, context, options));
        if (optionsToUse === null) {
            return null;
        }
        const { returnTypes: rawOption, fixer: rawFixerConfig, suggestions: rawSuggestionsConfigs } = optionsToUse;
        const { enforcement: rawEnforcement, ignoreClasses, ignoreNamePattern, ignoreTypePattern, ignoreInferredTypes, } = {
            ignoreClasses: optionsToUse.ignoreClasses,
            ignoreNamePattern: optionsToUse.ignoreNamePattern,
            ignoreTypePattern: optionsToUse.ignoreTypePattern,
            ignoreInferredTypes: optionsToUse.ignoreInferredTypes,
            ...(typeof rawOption === "object" ? rawOption : { enforcement: rawOption }),
        };
        const enforcement = parseEnforcement(rawEnforcement ?? optionsToUse.enforcement);
        if (enforcement === false ||
            shouldIgnoreClasses(node, context, ignoreClasses) ||
            shouldIgnorePattern(node, context, ignoreNamePattern)) {
            return null;
        }
        const fixerConfigs = parseFixerConfigs(rawFixerConfig, enforcement);
        const suggestionsConfigs = parseSuggestionsConfigs(rawSuggestionsConfigs, enforcement);
        return {
            ignoreTypePattern,
            ignoreInferredTypes,
            enforcement,
            fixerConfigs,
            suggestionsConfigs,
        };
    }
    if (node.returnType?.typeAnnotation !== undefined) {
        const [type, typeNode] = getTypeDataOfNode(node, context);
        const optionsToUse = getOptions(type, typeNode);
        if (optionsToUse === null) {
            return [];
        }
        const { ignoreTypePattern, enforcement, fixerConfigs, suggestionsConfigs } = optionsToUse;
        if (node.returnType?.typeAnnotation !== undefined && !isTSTypePredicate(node.returnType.typeAnnotation)) {
            if (shouldIgnorePattern(node.returnType, context, ignoreTypePattern)) {
                return [];
            }
            const immutability = getTypeImmutabilityOfNode(node.returnType.typeAnnotation, context, enforcement);
            if (immutability >= enforcement) {
                return [];
            }
            const { fix, suggestionFixers } = getAllFixers(node.returnType.typeAnnotation, context, fixerConfigs, suggestionsConfigs);
            return [
                {
                    node: node.returnType,
                    messageId: "returnType",
                    data: {
                        actual: Immutability[immutability],
                        expected: Immutability[enforcement],
                    },
                    fix,
                    suggest: suggestionFixers?.map(({ fix, message }) => ({
                        messageId: "userDefined",
                        data: {
                            message,
                        },
                        fix,
                    })) ?? null,
                },
            ];
        }
    }
    if (!isFunctionLike(node)) {
        return [];
    }
    const returnTypes = getReturnTypesOfFunction(node, context);
    if (returnTypes === null || returnTypes.length !== 1 || isImplementationOfOverload(node, context)) {
        return [];
    }
    const returnType = returnTypes[0];
    const optionsToUse = getOptions(returnType, returnType.node ?? null);
    if (optionsToUse === null) {
        return [];
    }
    const { ignoreInferredTypes, enforcement, fixerConfigs, suggestionsConfigs } = optionsToUse;
    if (ignoreInferredTypes) {
        return [];
    }
    const immutability = getTypeImmutabilityOfType(returnType, context, enforcement);
    if (immutability >= enforcement) {
        return [];
    }
    const { fix, suggestionFixers } = node.returnType?.typeAnnotation === undefined
        ? {}
        : getAllFixers(node.returnType.typeAnnotation, context, fixerConfigs, suggestionsConfigs);
    return [
        {
            node: hasID(node) && node.id !== null ? node.id : node,
            messageId: "returnType",
            data: {
                actual: Immutability[immutability],
                expected: Immutability[enforcement],
            },
            fix,
            suggest: suggestionFixers?.map(({ fix, message }) => ({
                messageId: "userDefined",
                data: {
                    message,
                },
                fix,
            })) ?? null,
        },
    ];
}
/**
 * Add the default options to the given options.
 */
function getOptionsWithDefaults$1(options) {
    if (options === null) {
        return null;
    }
    return {
        ...defaultOptions$6[0],
        ...options,
    };
}
/**
 * Check if the given function node violates this rule.
 */
function checkFunction$1(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const descriptors = [
        ...getParameterTypeViolations(node, context, options),
        ...getReturnTypeViolations(node, context, options),
    ];
    return {
        context,
        descriptors,
    };
}
/**
 * Check if the given function node violates this rule.
 */
function checkVariable(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const optionsToUse = getOptionsWithDefaults$1(getCoreOptions(node, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const { variables: rawOption, fixer: rawFixerConfig, suggestions: rawSuggestionsConfigs } = optionsToUse;
    const { enforcement: rawEnforcement, ignoreInferredTypes, ignoreClasses, ignoreNamePattern, ignoreTypePattern, ignoreInFunctions, } = {
        ignoreInferredTypes: optionsToUse.ignoreInferredTypes,
        ignoreClasses: optionsToUse.ignoreClasses,
        ignoreNamePattern: optionsToUse.ignoreNamePattern,
        ignoreTypePattern: optionsToUse.ignoreTypePattern,
        ignoreInFunctions: false,
        ...(typeof rawOption === "object" ? rawOption : { enforcement: rawOption }),
    };
    const enforcement = parseEnforcement(rawEnforcement ?? optionsToUse.enforcement);
    if (enforcement === false ||
        shouldIgnoreClasses(node, context, ignoreClasses) ||
        shouldIgnoreInFunction(node, context, ignoreInFunctions) ||
        shouldIgnorePattern(node, context, ignoreNamePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    const propertyDefinition = isPropertyDefinition(node);
    if (propertyDefinition && !node.readonly) {
        const fix = (fixer) => fixer.insertTextBefore(node.key, "readonly ");
        return {
            context,
            descriptors: [
                {
                    node,
                    messageId: "propertyModifier",
                    fix: rawFixerConfig === undefined ? null : fix,
                    suggest: [
                        {
                            messageId: "propertyModifierSuggestion",
                            fix,
                        },
                    ],
                },
            ],
        };
    }
    const nodeWithTypeAnnotation = propertyDefinition ? node : node.id;
    if (ignoreInferredTypes && nodeWithTypeAnnotation.typeAnnotation === undefined) {
        return {
            context,
            descriptors: [],
        };
    }
    if (nodeWithTypeAnnotation.typeAnnotation !== undefined &&
        shouldIgnorePattern(nodeWithTypeAnnotation.typeAnnotation, context, ignoreTypePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    const elements = isArrayPattern(nodeWithTypeAnnotation)
        ? nodeWithTypeAnnotation.elements
        : isObjectPattern(nodeWithTypeAnnotation)
            ? nodeWithTypeAnnotation.properties
            : [nodeWithTypeAnnotation];
    const elementResults = elements.map((element) => {
        if (!isDefined(element)) {
            return null;
        }
        const immutability = getTypeImmutabilityOfNode(element, context, enforcement);
        if (immutability >= enforcement) {
            return null;
        }
        const fixerConfigs = parseFixerConfigs(rawFixerConfig, enforcement);
        const suggestionsConfigs = parseSuggestionsConfigs(rawSuggestionsConfigs, enforcement);
        const { fix, suggestionFixers } = isMemberExpression(element) || isProperty(element) || element.typeAnnotation === undefined
            ? {}
            : getAllFixers(element.typeAnnotation.typeAnnotation, context, fixerConfigs, suggestionsConfigs);
        return { element, immutability, fix, suggestionFixers };
    });
    const messageId = propertyDefinition ? "propertyImmutability" : "variable";
    return {
        context,
        descriptors: elementResults.filter(isDefined).map(({ element, immutability, fix, suggestionFixers }) => {
            const data = {
                actual: Immutability[immutability],
                expected: Immutability[enforcement],
            };
            return {
                node: element,
                messageId,
                data,
                fix,
                suggest: suggestionFixers?.map(({ fix, message }) => ({
                    messageId: "userDefined",
                    data: {
                        message,
                    },
                    fix,
                })) ?? null,
            };
        }),
    };
}
// Create the rule.
const rule$6 = createRule(name$6, meta$7, defaultOptions$6, {
    ArrowFunctionExpression: checkFunction$1,
    FunctionDeclaration: checkFunction$1,
    FunctionExpression: checkFunction$1,
    TSCallSignatureDeclaration: checkFunction$1,
    TSConstructSignatureDeclaration: checkFunction$1,
    TSDeclareFunction: checkFunction$1,
    TSEmptyBodyFunctionExpression: checkFunction$1,
    TSFunctionType: checkFunction$1,
    TSMethodSignature: checkFunction$1,
    PropertyDefinition: checkVariable,
    VariableDeclarator: checkVariable,
});

/**
 * The name of this rule.
 */
const name$5 = "prefer-property-signatures";
/**
 * The schema for the rule options.
 */
const schema$5 = [
    {
        type: "object",
        properties: {
            ignoreIfReadonlyWrapped: {
                type: "boolean",
                default: false,
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$5 = [
    {
        ignoreIfReadonlyWrapped: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$5 = {
    generic: "Use a property signature instead of a method signature",
};
/**
 * The meta data for this rule.
 */
const meta$6 = {
    type: "suggestion",
    docs: {
        category: "Stylistic",
        description: "Prefer property signatures over method signatures.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$5,
    schema: schema$5,
};
/**
 * Check if the given TSMethodSignature violates this rule.
 */
function checkTSMethodSignature(node, context, options) {
    const [{ ignoreIfReadonlyWrapped }] = options;
    if (ignoreIfReadonlyWrapped && isInReadonly(node)) {
        return { context, descriptors: [] };
    }
    // All TS method signatures violate this rule.
    return { context, descriptors: [{ node, messageId: "generic" }] };
}
// Create the rule.
const rule$5 = createRule(name$5, meta$6, defaultOptions$5, {
    TSMethodSignature: checkTSMethodSignature,
});

/**
 * The name of this rule.
 */
const name$4 = "prefer-readonly-type";
/**
 * The schema for the rule options.
 */
const schema$4 = [
    {
        type: "object",
        properties: {
            allowLocalMutation: {
                type: "boolean",
            },
            ignorePattern: {
                type: ["string", "array"],
                items: {
                    type: "string",
                },
            },
            ignoreClass: {
                oneOf: [
                    {
                        type: "boolean",
                    },
                    {
                        type: "string",
                        enum: ["fieldsOnly"],
                    },
                ],
            },
            ignoreInterface: {
                type: "boolean",
            },
            allowMutableReturnType: {
                type: "boolean",
            },
            checkImplicit: {
                type: "boolean",
            },
            ignoreCollections: {
                type: "boolean",
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$4 = [
    {
        checkImplicit: false,
        ignoreClass: false,
        ignoreInterface: false,
        ignoreCollections: false,
        allowLocalMutation: false,
        allowMutableReturnType: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$4 = {
    array: "Only readonly arrays allowed.",
    implicit: "Implicitly a mutable array. Only readonly arrays allowed.",
    property: "A readonly modifier is required.",
    tuple: "Only readonly tuples allowed.",
    type: "Only readonly types allowed.",
};
/**
 * The meta data for this rule.
 */
const meta$5 = {
    deprecated: true,
    replacedBy: ["functional/prefer-immutable-types", "functional/type-declaration-immutability"],
    type: "suggestion",
    docs: {
        category: "No Mutations",
        description: "Prefer readonly types over mutable types.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$4,
    fixable: "code",
    schema: schema$4,
};
const mutableToImmutableTypes = new Map([
    ["Array", "ReadonlyArray"],
    ["Map", "ReadonlyMap"],
    ["Set", "ReadonlySet"],
]);
const mutableTypeRegex = new RegExp(`^${[...mutableToImmutableTypes.keys()].join("|")}$`, "u");
/**
 * For backwards compatibility.
 */
function shouldIgnorePattern2(node, context, ignorePattern, ignoreAccessorPattern) {
    const isTypeNode = isTSArrayType(node) ||
        isTSIndexSignature(node) ||
        isTSTupleType(node) ||
        isTSTypeAnnotation(node) ||
        isTSTypeLiteral(node) ||
        isTSTypeReference(node);
    if (isTypeNode) {
        return shouldIgnorePattern2(node.parent, context, ignorePattern, ignoreAccessorPattern);
    }
    return shouldIgnorePattern(node, context, ignorePattern, ignoreAccessorPattern);
}
/**
 * Check if the given ArrayType or TupleType violates this rule.
 */
function checkArrayOrTupleType(node, context, options) {
    const [optionsObject] = options;
    const { allowLocalMutation, allowMutableReturnType, ignoreClass, ignoreCollections, ignoreInterface, ignorePattern } = optionsObject;
    if (shouldIgnoreClasses(node, context, ignoreClass) ||
        (ignoreInterface && isInInterface(node)) ||
        shouldIgnoreInFunction(node, context, allowLocalMutation) ||
        shouldIgnorePattern2(node, context, ignorePattern) ||
        ignoreCollections) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: (node.parent === undefined || !isTSTypeOperator(node.parent) || node.parent.operator !== "readonly") &&
            (!allowMutableReturnType || !isInReturnType(node))
            ? [
                {
                    node,
                    messageId: isTSTupleType(node) ? "tuple" : "array",
                    fix: node.parent !== undefined && isTSArrayType(node.parent)
                        ? (fixer) => [
                            fixer.insertTextBefore(node, "(readonly "),
                            fixer.insertTextAfter(node, ")"),
                        ]
                        : (fixer) => fixer.insertTextBefore(node, "readonly "),
                },
            ]
            : [],
    };
}
/**
 * Check if the given TSMappedType violates this rule.
 */
function checkMappedType(node, context, options) {
    const [optionsObject] = options;
    const { allowLocalMutation, ignoreClass, ignoreInterface, ignorePattern } = optionsObject;
    if (shouldIgnoreClasses(node, context, ignoreClass) ||
        (ignoreInterface && isInInterface(node)) ||
        shouldIgnoreInFunction(node, context, allowLocalMutation) ||
        shouldIgnorePattern2(node, context, ignorePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: node.readonly === true || node.readonly === "+"
            ? []
            : [
                {
                    node,
                    messageId: "property",
                    fix: (fixer) => fixer.insertTextBeforeRange([node.range[0] + 1, node.range[1]], " readonly"),
                },
            ],
    };
}
/**
 * Check if the given TypeReference violates this rule.
 */
function checkTypeReference(node, context, options) {
    const [optionsObject] = options;
    const { allowLocalMutation, ignoreClass, ignoreInterface, ignorePattern, allowMutableReturnType, ignoreCollections } = optionsObject;
    if (shouldIgnoreClasses(node, context, ignoreClass) ||
        (ignoreInterface && isInInterface(node)) ||
        shouldIgnoreInFunction(node, context, allowLocalMutation) ||
        shouldIgnorePattern2(node, context, ignorePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    if (isIdentifier(node.typeName)) {
        if (ignoreCollections && mutableTypeRegex.test(node.typeName.name)) {
            return {
                context,
                descriptors: [],
            };
        }
        const immutableType = mutableToImmutableTypes.get(node.typeName.name);
        return {
            context,
            descriptors: immutableType !== undefined && immutableType.length > 0 && (!allowMutableReturnType || !isInReturnType(node))
                ? [
                    {
                        node,
                        messageId: "type",
                        fix: (fixer) => fixer.replaceText(node.typeName, immutableType),
                    },
                ]
                : [],
        };
    }
    return {
        context,
        descriptors: [],
    };
}
/**
 * Check if the given property/signature node violates this rule.
 */
function checkProperty(node, context, options) {
    const [optionsObject] = options;
    const { allowLocalMutation, ignoreClass, ignoreInterface, ignorePattern, allowMutableReturnType } = optionsObject;
    if (shouldIgnoreClasses(node, context, ignoreClass) ||
        (ignoreInterface && isInInterface(node)) ||
        shouldIgnoreInFunction(node, context, allowLocalMutation) ||
        shouldIgnorePattern2(node, context, ignorePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: !node.readonly && (!allowMutableReturnType || !isInReturnType(node))
            ? [
                {
                    node,
                    messageId: "property",
                    fix: isTSIndexSignature(node) || isTSPropertySignature(node)
                        ? (fixer) => fixer.insertTextBefore(node, "readonly ")
                        : isTSParameterProperty(node)
                            ? (fixer) => fixer.insertTextBefore(node.parameter, "readonly ")
                            : (fixer) => fixer.insertTextBefore(node.key, "readonly "),
                },
            ]
            : [],
    };
}
/**
 * Check if the given TypeReference violates this rule.
 */
function checkImplicitType(node, context, options) {
    const [optionsObject] = options;
    const { allowLocalMutation, ignoreClass, ignoreInterface, ignorePattern, checkImplicit, ignoreCollections } = optionsObject;
    if (!checkImplicit ||
        shouldIgnoreClasses(node, context, ignoreClass) ||
        (ignoreInterface && isInInterface(node)) ||
        shouldIgnoreInFunction(node, context, allowLocalMutation) ||
        shouldIgnorePattern2(node, context, ignorePattern)) {
        return {
            context,
            descriptors: [],
        };
    }
    const declarators = isFunctionLike(node)
        ? node.params
            .map((param) => isAssignmentPattern(param)
            ? {
                id: param.left,
                init: param.right,
                node: param,
            }
            : undefined)
            .filter((param) => param !== undefined)
        : node.declarations.map((declaration) => ({
            id: declaration.id,
            init: declaration.init,
            node: declaration,
        }));
    return {
        context,
        descriptors: declarators.flatMap((declarator) => isIdentifier(declarator.id) &&
            declarator.id.typeAnnotation === undefined &&
            declarator.init !== null &&
            isArrayType(context, getTypeOfNode(declarator.init, context)) &&
            !ignoreCollections
            ? [
                {
                    node: declarator.node,
                    messageId: "implicit",
                    fix: (fixer) => fixer.insertTextAfter(declarator.id, ": readonly unknown[]"),
                },
            ]
            : []),
    };
}
// Create the rule.
const rule$4 = createRule(name$4, meta$5, defaultOptions$4, {
    ArrowFunctionExpression: checkImplicitType,
    PropertyDefinition: checkProperty,
    FunctionDeclaration: checkImplicitType,
    FunctionExpression: checkImplicitType,
    TSArrayType: checkArrayOrTupleType,
    TSIndexSignature: checkProperty,
    TSParameterProperty: checkProperty,
    TSPropertySignature: checkProperty,
    TSTupleType: checkArrayOrTupleType,
    TSMappedType: checkMappedType,
    TSTypeReference: checkTypeReference,
    VariableDeclaration: checkImplicitType,
});

/**
 * The name of this rule.
 */
const name$3 = "prefer-tacit";
/**
 * The schema for the rule options.
 */
const schema$3 = [
    {
        type: "object",
        properties: {
            checkMemberExpressions: {
                type: "boolean",
            },
        },
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$3 = [
    {
        checkMemberExpressions: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages$3 = {
    generic: "Potentially unnecessary function wrapper.",
    genericSuggestion: "Remove unnecessary function wrapper.",
};
/**
 * The meta data for this rule.
 */
const meta$4 = {
    type: "suggestion",
    docs: {
        category: "Stylistic",
        description: "Replaces `x => f(x)` with just `f`.",
        recommended: "recommended",
        recommendedSeverity: "warn",
        requiresTypeChecking: true,
    },
    messages: errorMessages$3,
    hasSuggestions: true,
    schema: schema$3,
};
/**
 * From the callee's type, does it follow that the caller violates this rule.
 */
function isCallerViolation(caller, calleeType, context) {
    if (calleeType.symbol === undefined) {
        return false;
    }
    const tsDeclaration = calleeType.symbol.valueDeclaration ?? calleeType.symbol.declarations?.[0];
    if (tsDeclaration === undefined) {
        return false;
    }
    return getTypeOfTSNode(tsDeclaration, context)
        .getCallSignatures()
        .some((signature) => signature.parameters.length === caller.arguments.length);
}
/**
 * Is the given node a direct child of a getter.
 */
function isDirectChildOfGetter(node) {
    const { parent } = node;
    if (parent?.type !== TSESTree.AST_NODE_TYPES.Property) {
        return false;
    }
    return parent.kind === "get";
}
/**
 * Get the fixes for a call to a reference violation.
 */
function fixFunctionCallToReference(context, fixer, node, caller) {
    // Fix to Instantiation Expression.
    if (caller.typeArguments !== undefined && caller.typeArguments.params.length > 0) {
        return [
            fixer.removeRange([node.range[0], caller.callee.range[0]]),
            fixer.removeRange([caller.typeArguments.range[1], node.range[1]]),
        ];
    }
    return [
        fixer.replaceText(node, isMemberExpression(caller.callee)
            ? `${context.sourceCode.getText(caller.callee)}.bind(${context.sourceCode.getText(caller.callee.object)})`
            : context.sourceCode.getText(caller.callee)),
    ];
}
/**
 * Creates the suggestions.
 */
function buildSuggestions(context, node, caller) {
    return [
        {
            messageId: "genericSuggestion",
            fix: (fixer) => {
                const functionCallToReference = fixFunctionCallToReference(context, fixer, node, caller);
                if (functionCallToReference === null) {
                    return null;
                }
                if (node.type === TSESTree.AST_NODE_TYPES.FunctionDeclaration && !isNested(node)) {
                    if (node.id === null) {
                        return null;
                    }
                    return [
                        fixer.insertTextBefore(node, `const ${node.id.name} = `),
                        fixer.insertTextAfter(node, `;`),
                        ...functionCallToReference,
                    ];
                }
                return functionCallToReference;
            },
        },
    ];
}
/**
 * Check for violations based on the given caller.
 */
function getCallDescriptors(node, context, options, caller) {
    const [{ checkMemberExpressions }] = options;
    if (!isIdentifier(caller.callee) && !(checkMemberExpressions && isMemberExpression(caller.callee))) {
        return [];
    }
    if (node.params.length === caller.arguments.length &&
        node.params.every((param, index) => {
            const callArg = caller.arguments[index];
            return isIdentifier(callArg) && isIdentifier(param) && callArg.name === param.name;
        })) {
        const calleeType = getTypeOfNode(caller.callee, context);
        if (calleeType !== null && isCallerViolation(caller, calleeType, context)) {
            return [
                {
                    node,
                    messageId: "generic",
                    suggest: buildSuggestions(context, node, caller),
                },
            ];
        }
        return [];
    }
    return [];
}
/**
 * Check for violations in the form: `x => f(x)`.
 */
function getDirectCallDescriptors(node, context, options) {
    if (isCallExpression(node.body)) {
        return getCallDescriptors(node, context, options, node.body);
    }
    return [];
}
/**
 * Check for violations in the form: `x => { return f(x); }`.
 */
function getNestedCallDescriptors(node, context, options) {
    if (isBlockStatement(node.body) &&
        node.body.body.length === 1 &&
        isReturnStatement(node.body.body[0]) &&
        node.body.body[0].argument !== null &&
        isCallExpression(node.body.body[0].argument)) {
        return getCallDescriptors(node, context, options, node.body.body[0].argument);
    }
    return [];
}
/**
 * Check if the given function node violates this rule.
 */
function checkFunction(node, context, options) {
    if (isDirectChildOfGetter(node)) {
        return {
            context,
            descriptors: [],
        };
    }
    return {
        context,
        descriptors: [
            ...getDirectCallDescriptors(node, context, options),
            ...getNestedCallDescriptors(node, context, options),
        ],
    };
}
// Create the rule.
const rule$3 = createRule(name$3, meta$4, defaultOptions$3, {
    FunctionDeclaration: checkFunction,
    FunctionExpression: checkFunction,
    ArrowFunctionExpression: checkFunction,
});

/**
 * The name of this rule.
 */
const name$2 = "readonly-type";
/**
 * The schema for the rule options.
 */
const schema$2 = [
    {
        type: "string",
        enum: ["generic", "keyword"],
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions$2 = ["generic"];
/**
 * The possible error messages.
 */
const errorMessages$2 = {
    generic: "Readonly type using 'readonly' keyword is forbidden. Use 'Readonly<T>' instead.",
    keyword: "Readonly type using 'Readonly<T>' is forbidden. Use 'readonly' keyword instead.",
};
/**
 * The meta data for this rule.
 */
const meta$3 = {
    type: "suggestion",
    docs: {
        category: "Stylistic",
        description: "Require consistently using either `readonly` keywords or `Readonly<T>`",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    fixable: "code",
    messages: errorMessages$2,
    schema: schema$2,
};
/**
 * Check for violations with a type literal.
 */
function checkTypeLiteral(node, context, options) {
    const [mode] = options;
    const readonlyWrapper = getReadonly(node);
    const { sourceCode } = context;
    if (readonlyWrapper !== null) {
        if (mode === "generic") {
            return {
                context,
                descriptors: node.members
                    .map((member) => {
                    if ((isPropertyDefinition(member) || isTSParameterProperty(member) || isTSPropertySignature(member)) &&
                        member.readonly) {
                        return {
                            node: member.key,
                            messageId: "generic",
                            fix: (fixer) => fixer.replaceText(member, sourceCode.getText(member).replace(/readonly /u, "")),
                        };
                    }
                    return undefined;
                })
                    .filter(isDefined),
            };
        }
        return {
            context,
            descriptors: [
                {
                    node: isTSTypeReference(readonlyWrapper) ? readonlyWrapper.typeName : readonlyWrapper,
                    messageId: "keyword",
                    fix: (fixer) => {
                        const text = sourceCode.getText(readonlyWrapper);
                        const wrapperStartPattern = /^Readonly\s*</gu;
                        const wrapperEndPattern = /\s*>$/u;
                        wrapperStartPattern.exec(text);
                        const end = wrapperEndPattern.exec(text);
                        const startCutPoint = wrapperStartPattern.lastIndex;
                        const endCutPoint = end.index;
                        return [
                            fixer.removeRange([readonlyWrapper.range[0], readonlyWrapper.range[0] + startCutPoint]),
                            fixer.removeRange([readonlyWrapper.range[1] - text.length + endCutPoint, readonlyWrapper.range[1]]),
                            ...node.members
                                .map((member) => {
                                if (!(isPropertyDefinition(member) ||
                                    isTSIndexSignature(member) ||
                                    isTSParameterProperty(member) ||
                                    isTSPropertySignature(member)) ||
                                    member.readonly) {
                                    return undefined;
                                }
                                return fixer.insertTextBefore(member, "readonly ");
                            })
                                .filter(isDefined),
                        ];
                    },
                },
            ],
        };
    }
    if (mode === "generic") {
        const needsWrapping = node.members.length > 0 &&
            node.members.every((member) => (isPropertyDefinition(member) ||
                isTSIndexSignature(member) ||
                isTSParameterProperty(member) ||
                isTSPropertySignature(member)) &&
                member.readonly);
        if (needsWrapping) {
            return {
                context,
                descriptors: [
                    {
                        node,
                        messageId: "generic",
                        fix: (fixer) => [
                            fixer.insertTextBefore(node, "Readonly<"),
                            fixer.insertTextAfter(node, ">"),
                            ...node.members.map((member) => fixer.replaceText(member, sourceCode.getText(member).replace(/readonly /u, ""))),
                        ],
                    },
                ],
            };
        }
    }
    return {
        context,
        descriptors: [],
    };
}
// Create the rule.
const rule$2 = createRule(name$2, meta$3, defaultOptions$2, {
    TSTypeLiteral: checkTypeLiteral,
});

/**
 * The name of this rule.
 */
const name$1 = "strict-tuples";
const coreOptionsPropertiesSchema = deepmerge({});
/**
 * The schema for the rule options.
 */
const schema$1 = [overridableOptionsSchema(coreOptionsPropertiesSchema)];
/**
 * The default options for the rule.
 */
const defaultOptions$1 = [{}];
/**
 * The possible error messages.
 */
const errorMessages$1 = {
    mutateLength: "Modifying the length of a tuple is not allowed.",
    assignToArray: "Tuple types are not assignable to array types.",
};
/**
 * The meta data for this rule.
 */
const meta$2 = {
    type: "suggestion",
    docs: {
        category: "No Mutations",
        description: "Enforce treating tuples as fixed length.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages$1,
    schema: schema$1,
};
/**
 * Array methods that mutate an array.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/prototype#Methods#Mutator_methods
 */
const arrayLengthMutatorMethods = new Set(["pop", "push", "shift", "splice", "unshift"]);
/**
 * Add the default options to the given options.
 */
function getOptionsWithDefaults(options) {
    if (options === null) {
        return null;
    }
    return {
        ...defaultOptions$1[0],
        ...options,
    };
}
/**
 * Check if the given node violates this rule.
 */
function checkCallExpression(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const rootNode = findRootIdentifier(node.callee) ?? node.callee;
    const optionsToUse = getOptionsWithDefaults(getCoreOptions(rootNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    // Not potential object mutation?
    if (!isMemberExpression(node.callee) || !isIdentifier(node.callee.property)) {
        return {
            context,
            descriptors: [],
        };
    }
    // Tuple length mutation?
    if (arrayLengthMutatorMethods.has(node.callee.property.name) &&
        // !isInChainCallAndFollowsNew(node.callee, context) &&
        isTupleTypeReference(getTypeOfNode(node.callee.object, context))) {
        return {
            context,
            descriptors: [{ node, messageId: "mutateLength" }],
        };
    }
    return {
        context,
        descriptors: [],
    };
}
/**
 * Check if the given assignment expression violates this rule.
 */
function checkAssignmentExpression(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    const rootNode = findRootIdentifier(node.left) ?? node.left;
    const optionsToUse = getOptionsWithDefaults(getCoreOptions(rootNode, context, options));
    if (optionsToUse === null) {
        return {
            context,
            descriptors: [],
        };
    }
    if (isArrayType(context, getTypeOfNode(node.left, context)) &&
        isTupleTypeReference(getTypeOfNode(node.right, context))) {
        return {
            context,
            descriptors: [{ node, messageId: "assignToArray" }],
        };
    }
    return {
        context,
        descriptors: [],
    };
}
function checkVariableDeclaration(node, context, rawOptions) {
    const options = upgradeRawOverridableOptions(rawOptions[0]);
    if (options === null) {
        return {
            context,
            descriptors: [],
        };
    }
    const descriptors = node.declarations
        .map((declaration) => {
        const leftType = declaration.id.typeAnnotation?.typeAnnotation;
        const rightNode = declaration.init;
        if (leftType !== undefined &&
            rightNode !== null &&
            isArrayType(context, getTypeOfNode(leftType, context)) &&
            isTupleTypeReference(getTypeOfNode(rightNode, context))) {
            return { node: declaration, messageId: "assignToArray" };
        }
        return null;
    })
        .filter((descriptor) => descriptor !== null);
    return { context, descriptors };
}
// Create the rule.
const rule$1 = createRule(name$1, meta$2, defaultOptions$1, {
    CallExpression: checkCallExpression,
    AssignmentExpression: checkAssignmentExpression,
    VariableDeclaration: checkVariableDeclaration,
});

/**
 * The name of this rule.
 */
const name = "type-declaration-immutability";
/**
 * The full name of this rule.
 */
const fullName = `${ruleNameScope}/${name}`;
/**
 * How the actual immutability should be compared to the given immutability.
 */
var RuleEnforcementComparator;
(function (RuleEnforcementComparator) {
    RuleEnforcementComparator[RuleEnforcementComparator["Less"] = -2] = "Less";
    RuleEnforcementComparator[RuleEnforcementComparator["AtMost"] = -1] = "AtMost";
    RuleEnforcementComparator[RuleEnforcementComparator["Exactly"] = 0] = "Exactly";
    RuleEnforcementComparator[RuleEnforcementComparator["AtLeast"] = 1] = "AtLeast";
    RuleEnforcementComparator[RuleEnforcementComparator["More"] = 2] = "More";
})(RuleEnforcementComparator || (RuleEnforcementComparator = {}));
/**
 * The schema for each fixer config.
 */
const fixerSchema = {
    oneOf: [
        {
            type: "boolean",
            enum: [false],
        },
        {
            type: "object",
            properties: {
                pattern: { type: "string" },
                replace: { type: "string" },
            },
            additionalProperties: false,
        },
        {
            type: "array",
            items: {
                type: "object",
                properties: {
                    pattern: { type: "string" },
                    replace: { type: "string" },
                },
                additionalProperties: false,
            },
        },
    ],
};
const suggestionsSchema = {
    oneOf: [
        {
            type: "boolean",
            enum: [false],
        },
        {
            type: "array",
            items: {
                type: "object",
                properties: {
                    pattern: { type: "string" },
                    replace: { type: "string" },
                },
                additionalProperties: false,
            },
        },
    ],
};
/**
 * The schema for the rule options.
 */
const schema = [
    {
        type: "object",
        properties: deepmerge(ignoreIdentifierPatternOptionSchema, {
            rules: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        identifiers: {
                            type: ["string", "array"],
                            items: {
                                type: ["string"],
                            },
                        },
                        immutability: {
                            type: ["string", "number"],
                            enum: Object.values(Immutability).filter((i) => i !== Immutability.Unknown && i !== Immutability[Immutability.Unknown]),
                        },
                        comparator: {
                            type: ["string", "number"],
                            enum: Object.values(RuleEnforcementComparator),
                        },
                        fixer: fixerSchema,
                        suggestions: suggestionsSchema,
                    },
                    required: ["identifiers", "immutability"],
                    additionalProperties: false,
                },
            },
            ignoreInterfaces: {
                type: "boolean",
            },
        }),
        additionalProperties: false,
    },
];
/**
 * The default options for the rule.
 */
const defaultOptions = [
    {
        rules: [
            {
                identifiers: ["^(?!I?Mutable).+"],
                immutability: Immutability.Immutable,
                comparator: RuleEnforcementComparator.AtLeast,
            },
        ],
        ignoreInterfaces: false,
    },
];
/**
 * The possible error messages.
 */
const errorMessages = {
    Less: 'This type is declare to have an immutability less than "{{ expected }}" (actual: "{{ actual }}").',
    AtLeast: 'This type is declare to have an immutability of at least "{{ expected }}" (actual: "{{ actual }}").',
    Exactly: 'This type is declare to have an immutability of exactly "{{ expected }}" (actual: "{{ actual }}").',
    AtMost: 'This type is declare to have an immutability of at most "{{ expected }}" (actual: "{{ actual }}").',
    More: 'This type is declare to have an immutability more than "{{ expected }}" (actual: "{{ actual }}").',
    userDefined: "{{ message }}",
};
/**
 * The meta data for this rule.
 */
const meta$1 = {
    type: "suggestion",
    docs: {
        category: "No Mutations",
        description: "Enforce the immutability of types based on patterns.",
        recommended: "recommended",
        recommendedSeverity: "error",
        requiresTypeChecking: true,
    },
    messages: errorMessages,
    fixable: "code",
    hasSuggestions: true,
    schema,
};
/**
 * Get all the rules that were given and upgrade them.
 */
function getRules(options) {
    const [optionsObject] = options;
    const { rules: rulesOptions } = optionsObject;
    return rulesOptions.map((rule) => {
        const identifiers = Array.isArray(rule.identifiers)
            ? rule.identifiers.map((id) => new RegExp(id, "u"))
            : [new RegExp(rule.identifiers, "u")];
        const immutability = typeof rule.immutability === "string" ? Immutability[rule.immutability] : rule.immutability;
        const comparator = rule.comparator === undefined
            ? RuleEnforcementComparator.AtLeast
            : typeof rule.comparator === "string"
                ? RuleEnforcementComparator[rule.comparator]
                : rule.comparator;
        const fixers = rule.fixer === undefined || rule.fixer === false
            ? false
            : (Array.isArray(rule.fixer) ? rule.fixer : [rule.fixer]).map((r) => ({
                ...r,
                pattern: new RegExp(r.pattern, "su"),
            }));
        const suggestions = rule.suggestions === undefined || rule.suggestions === false
            ? false
            : rule.suggestions.map((r) => ({
                ...r,
                pattern: new RegExp(r.pattern, "su"),
            }));
        return {
            identifiers,
            immutability,
            comparator,
            fixers,
            suggestions,
        };
    });
}
/**
 * Find the first rule to apply to the given node.
 */
function getRuleToApply(node, context, options) {
    const rules = getRules(options);
    if (rules.length === 0) {
        return undefined;
    }
    const texts = getNodeIdentifierTexts(node, context);
    if (texts.length === 0) {
        return undefined;
    }
    return rules.find((rule) => rule.identifiers.some((pattern) => texts.some((text) => pattern.test(text))));
}
/**
 * Get a fixer that uses the user config.
 */
function getConfiguredFixer(node, context, configs) {
    const text = context.sourceCode.getText(node);
    const config = configs.find((c) => c.pattern.test(text));
    if (config === undefined) {
        return null;
    }
    return (fixer) => fixer.replaceText(node, text.replace(config.pattern, config.replace));
}
/**
 * Get the suggestions that uses the user config.
 */
function getConfiguredSuggestions(node, context, configs) {
    const text = context.sourceCode.getText(node);
    const matchingConfig = configs.filter((c) => c.pattern.test(text));
    if (matchingConfig.length === 0) {
        return null;
    }
    return matchingConfig.map((config) => ({
        fix: (fixer) => fixer.replaceText(node, text.replace(config.pattern, config.replace)),
        messageId: "userDefined",
        data: {
            message: config.message ?? `Replace with: ${text.replace(config.pattern, config.replace)}`,
        },
    }));
}
/**
 * Compare the actual immutability to the expected immutability.
 */
function compareImmutability(rule, actual) {
    switch (rule.comparator) {
        case RuleEnforcementComparator.Less: {
            return actual < rule.immutability;
        }
        case RuleEnforcementComparator.AtMost: {
            return actual <= rule.immutability;
        }
        case RuleEnforcementComparator.Exactly: {
            return actual === rule.immutability;
        }
        case RuleEnforcementComparator.AtLeast: {
            return actual >= rule.immutability;
        }
        case RuleEnforcementComparator.More: {
            return actual > rule.immutability;
        }
    }
}
/**
 * Get the results.
 */
function getResults(node, context, rule, immutability) {
    const valid = compareImmutability(rule, immutability);
    if (valid) {
        return {
            context,
            descriptors: [],
        };
    }
    const messageId = RuleEnforcementComparator[rule.comparator];
    const fix = rule.fixers === false || isTSInterfaceDeclaration(node)
        ? null
        : getConfiguredFixer(node.typeAnnotation, context, rule.fixers);
    const suggest = rule.suggestions === false || isTSInterfaceDeclaration(node)
        ? null
        : getConfiguredSuggestions(node.typeAnnotation, context, rule.suggestions);
    return {
        context,
        descriptors: [
            {
                node: node.id,
                messageId,
                data: {
                    actual: Immutability[immutability],
                    expected: Immutability[rule.immutability],
                },
                fix,
                suggest,
            },
        ],
    };
}
/**
 * Check if the given Interface or Type Alias violates this rule.
 */
function checkTypeDeclaration(node, context, options) {
    const [optionsObject] = options;
    const { ignoreInterfaces, ignoreIdentifierPattern } = optionsObject;
    if (shouldIgnorePattern(node, context, ignoreIdentifierPattern) ||
        (ignoreInterfaces && isTSInterfaceDeclaration(node))) {
        return {
            context,
            descriptors: [],
        };
    }
    const rule = getRuleToApply(node, context, options);
    if (rule === undefined) {
        return {
            context,
            descriptors: [],
        };
    }
    const maxImmutability = rule.comparator === RuleEnforcementComparator.AtLeast
        ? rule.immutability
        : rule.comparator === RuleEnforcementComparator.More
            ? rule.immutability + 1
            : undefined;
    const immutability = getTypeImmutabilityOfNode(node, context, maxImmutability);
    return getResults(node, context, rule, immutability);
}
// Create the rule.
const rule = createRule(name, meta$1, defaultOptions, {
    TSTypeAliasDeclaration: checkTypeDeclaration,
    TSInterfaceDeclaration: checkTypeDeclaration,
});

/**
 * All of the custom rules.
 */
const rules = {
    [name$k]: rule$k,
    [name$j]: rule$j,
    [name$h]: rule$h,
    [name$i]: rule$i,
    [name$g]: rule$g,
    [name$f]: rule$f,
    [name$e]: rule$e,
    [name$d]: rule$d,
    [name$c]: rule$c,
    [name$b]: rule$b,
    [name$a]: rule$a,
    [name$9]: rule$9,
    [name$8]: rule$8,
    [name$7]: rule$7,
    [name$6]: rule$6,
    [name$5]: rule$5,
    [name$4]: rule$4,
    [name$3]: rule$3,
    [name$2]: rule$2,
    [name$1]: rule$1,
    [name]: rule,
};

var all = {
    ...Object.fromEntries(Object.entries(rules)
        .filter(([, rule]) => rule.meta.deprecated !== true)
        .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity])),
};

var currying = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true && rule.meta.docs.category === "Currying" && rule.meta.docs.recommended !== false)
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

var disableTypeChecked = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.docs.requiresTypeChecking)
    .map(([name]) => [`${ruleNameScope}/${name}`, "off"]));

var externalVanillaRecommended = {
    "prefer-const": "error",
    "no-param-reassign": "error",
    "no-var": "error",
};

const tsConfig = {
    "@typescript-eslint/prefer-readonly": "error",
    "@typescript-eslint/switch-exhaustiveness-check": "error",
};
var externalTypeScriptRecommended = {
    ...externalVanillaRecommended,
    ...tsConfig,
};

const recommended = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.recommended === "recommended" &&
    rule.meta.docs.category !== "Stylistic")
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));
const overrides$1 = {
    [fullName$a]: [
        "error",
        {
            enforceParameterCount: false,
            overrides: [
                {
                    specifiers: [
                        {
                            from: "file",
                        },
                    ],
                    options: {
                        enforceParameterCount: {
                            count: "atLeastOne",
                            ignoreLambdaExpression: true,
                            ignoreIIFE: true,
                            ignoreGettersAndSetters: true,
                        },
                    },
                },
            ],
        },
    ],
    [fullName$7]: [
        "error",
        {
            allowReturningBranches: true,
        },
    ],
    [fullName$5]: [
        "error",
        {
            allowInForLoopInit: true,
        },
    ],
    [fullName$4]: "off",
    [fullName$3]: [
        "error",
        {
            allowToRejectPromises: true,
        },
    ],
    [fullName$2]: "off",
    [fullName$1]: [
        "error",
        {
            enforcement: "None",
            overrides: [
                {
                    specifiers: [
                        {
                            from: "lib",
                        },
                        {
                            from: "package",
                        },
                    ],
                    options: {
                        ignoreInferredTypes: true,
                        parameters: {
                            enforcement: "ReadonlyShallow",
                        },
                    },
                },
                {
                    specifiers: {
                        from: "file",
                    },
                    options: {
                        ignoreInferredTypes: true,
                        parameters: {
                            enforcement: "ReadonlyDeep",
                        },
                    },
                },
            ],
        },
    ],
    [fullName]: [
        "error",
        {
            rules: [
                {
                    identifiers: ["^I?Immutable.+"],
                    immutability: Immutability.Immutable,
                    comparator: RuleEnforcementComparator.AtLeast,
                },
                {
                    identifiers: ["^I?ReadonlyDeep.+"],
                    immutability: Immutability.ReadonlyDeep,
                    comparator: RuleEnforcementComparator.AtLeast,
                },
                {
                    identifiers: ["^I?Readonly.+"],
                    immutability: Immutability.ReadonlyShallow,
                    comparator: RuleEnforcementComparator.AtLeast,
                    suggestions: [
                        {
                            pattern: "^(Array|Map|Set)<(.+)>$",
                            replace: "Readonly$1<$2>",
                        },
                        {
                            pattern: "^(.+)$",
                            replace: "Readonly<$1>",
                        },
                    ],
                },
                {
                    identifiers: ["^I?Mutable.+"],
                    immutability: Immutability.Mutable,
                    comparator: RuleEnforcementComparator.AtMost,
                    suggestions: [
                        {
                            pattern: "^Readonly(Array|Map|Set)<(.+)>$",
                            replace: "$1<$2>",
                        },
                        {
                            pattern: "^Readonly<(.+)>$",
                            replace: "$1",
                        },
                    ],
                },
            ],
        },
    ],
};
var recommended$1 = {
    ...recommended,
    ...overrides$1,
};

const overrides = {
    [fullName$a]: [
        "error",
        {
            enforceParameterCount: false,
        },
    ],
    [fullName$9]: ["error", { ignoreClasses: "fieldsOnly" }],
    [fullName$8]: "off",
    [fullName$7]: "off",
    [fullName$6]: "off",
    [fullName$1]: [
        "error",
        {
            enforcement: "None",
            overrides: [
                {
                    specifiers: {
                        from: "file",
                    },
                    options: {
                        ignoreInferredTypes: true,
                        parameters: {
                            enforcement: "ReadonlyShallow",
                        },
                    },
                },
            ],
        },
    ],
};
var lite = {
    ...recommended$1,
    ...overrides,
};

var noExceptions = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.category === "No Exceptions" &&
    rule.meta.docs.recommended !== false)
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

var noMutations = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.category === "No Mutations" &&
    rule.meta.docs.recommended !== false)
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

var noOtherParadigms = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.category === "No Other Paradigms" &&
    rule.meta.docs.recommended !== false)
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

var noStatements = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.category === "No Statements" &&
    rule.meta.docs.recommended !== false)
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

var off = Object.fromEntries(Object.entries(rules).map(([name]) => [`${ruleNameScope}/${name}`, "off"]));

var strict = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.recommended !== false &&
    rule.meta.docs.category !== "Stylistic")
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

var stylistic = Object.fromEntries(Object.entries(rules)
    .filter(([, rule]) => rule.meta.deprecated !== true &&
    rule.meta.docs.category === "Stylistic" &&
    rule.meta.docs.recommended !== false)
    .map(([name, rule]) => [`${ruleNameScope}/${name}`, rule.meta.docs.recommendedSeverity]));

const meta = {
    name: "eslint-plugin-functional",
    version: __VERSION__,
};
const functional = {
    meta,
    rules,
};
const plugins = { functional };
const configs = {
    all: { plugins, rules: all },
    lite: { plugins, rules: lite },
    recommended: { plugins, rules: recommended$1 },
    strict: { plugins, rules: strict },
    off: { plugins, rules: off },
    disableTypeChecked: {
        plugins,
        rules: disableTypeChecked,
    },
    externalVanillaRecommended: {
        plugins,
        rules: externalVanillaRecommended,
    },
    externalTypeScriptRecommended: {
        plugins,
        rules: externalTypeScriptRecommended,
    },
    currying: { plugins, rules: currying },
    noExceptions: { plugins, rules: noExceptions },
    noMutations: { plugins, rules: noMutations },
    noOtherParadigms: {
        plugins,
        rules: noOtherParadigms,
    },
    noStatements: { plugins, rules: noStatements },
    stylistic: { plugins, rules: stylistic },
};
// eslint-disable-next-line functional/immutable-data
functional.configs = configs;

export { functional as default };
