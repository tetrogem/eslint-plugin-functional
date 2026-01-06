import type { TSESTree } from "@typescript-eslint/utils";
import { getParserServices } from "@typescript-eslint/utils/eslint-utils";
import type { JSONSchema4, JSONSchema4ObjectSchema } from "@typescript-eslint/utils/json-schema";
import type { RuleContext } from "@typescript-eslint/utils/ts-eslint";
import { deepmerge } from "deepmerge-ts";
import { isNamedDeclarationWithName } from "ts-api-utils";
import {
  type Declaration,
  IndexKind,
  type Symbol,
  type Type,
  isNumericLiteral,
  isStringLiteral,
} from "typescript";

import {
  type OverridableOptions,
  type RawOverridableOptions,
  getCoreOptions,
  upgradeRawOverridableOptions,
} from "#/options";
import { ruleNameScope } from "#/utils/misc";
import { type NamedCreateRuleCustomMeta, type Rule, type RuleResult, createRule, getTypeOfNode } from "#/utils/rule";
import { overridableOptionsSchema } from "#/utils/schemas";
import { findRootIdentifier } from "#/utils/tree";
import { isIdentifier, isMemberExpression } from "#/utils/type-guards";

/**
 * The name of this rule.
 */
export const name = "strict-tuples";

/**
 * The full name of this rule.
 */
export const fullName: `${typeof ruleNameScope}/${typeof name}` = `${ruleNameScope}/${name}`;

type CoreOptions = {};

/**
 * The options this rule can take.
 */
type RawOptions = [RawOverridableOptions<CoreOptions>];
type Options = OverridableOptions<CoreOptions>;

const coreOptionsPropertiesSchema = deepmerge({}) as NonNullable<JSONSchema4ObjectSchema["properties"]>;

/**
 * The schema for the rule options.
 */
const schema: JSONSchema4[] = [overridableOptionsSchema(coreOptionsPropertiesSchema)];

/**
 * The default options for the rule.
 */
const defaultOptions = [{}] satisfies RawOptions;

/**
 * The possible error messages.
 */
const errorMessages = {
  mutateLength: "Modifying the length of a tuple is not allowed.",
  assignToArray: "Type '{{ tupleType }}' is not assignable to type '{{ arrayType }}'.",
} as const;

/**
 * The meta data for this rule.
 */
const meta: NamedCreateRuleCustomMeta<keyof typeof errorMessages, RawOptions> = {
  type: "suggestion",
  docs: {
    category: "No Mutations",
    description: "Enforce treating tuples as fixed length.",
    recommended: "recommended",
    recommendedSeverity: "error",
    requiresTypeChecking: true,
  },
  messages: errorMessages,
  schema,
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
function getOptionsWithDefaults(options: Readonly<Options> | null): Options | null {
  if (options === null) {
    return null;
  }

  return {
    ...defaultOptions[0],
    ...options,
  };
}

/**
 * Check if the given node violates this rule.
 */
function checkCallExpression(
  node: TSESTree.CallExpression,
  context: Readonly<RuleContext<keyof typeof errorMessages, RawOptions>>,
  rawOptions: Readonly<RawOptions>,
): RuleResult<keyof typeof errorMessages, RawOptions> {
  const options = upgradeRawOverridableOptions(rawOptions[0]);
  const rootNode = findRootIdentifier(node.callee) ?? node.callee;
  const optionsToUse = getOptionsWithDefaults(getCoreOptions<CoreOptions, Options>(rootNode, context, options));

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

    const checker = getParserServices(context).program.getTypeChecker();

  // Tuple length mutation?
  if (
    arrayLengthMutatorMethods.has(node.callee.property.name) &&
    // !isInChainCallAndFollowsNew(node.callee, context) &&
    checker.isTupleType(getTypeOfNode(node.callee.object, context))
  ) {
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
function checkAssignmentExpression(
  node: TSESTree.AssignmentExpression,
  context: Readonly<RuleContext<keyof typeof errorMessages, RawOptions>>,
  rawOptions: Readonly<RawOptions>,
): RuleResult<keyof typeof errorMessages, RawOptions> {
  const options = upgradeRawOverridableOptions(rawOptions[0]);
  const rootNode = findRootIdentifier(node.left) ?? node.left;
  const optionsToUse = getOptionsWithDefaults(getCoreOptions<CoreOptions, Options>(rootNode, context, options));

  if (optionsToUse === null) {
    return {
      context,
      descriptors: [],
    };
  }

  const error = isAssignableViaStrictTupleTypes(
    getTypeOfNode(node.left, context),
    getTypeOfNode(node.right, context),
    context,
  );

  if (error !== null) {
    return {
      context,
      descriptors: [assignToArrayErrorIntoDescriptor(node, error)],
    };
  }

  return {
    context,
    descriptors: [],
  };
}

function checkVariableDeclaration(
  node: TSESTree.VariableDeclaration,
  context: Readonly<RuleContext<keyof typeof errorMessages, RawOptions>>,
  rawOptions: Readonly<RawOptions>,
): RuleResult<keyof typeof errorMessages, RawOptions> {
  const options = upgradeRawOverridableOptions(rawOptions[0]);

  if (options === null) {
    return {
      context,
      descriptors: [],
    };
  }

  // console.log(node.declarations.length);

  const descriptors = node.declarations
    .map((declaration) => {
      const leftTypeAnnotation = declaration.id.typeAnnotation?.typeAnnotation;
      const rightNode = declaration.init;
      if (leftTypeAnnotation !== undefined && rightNode !== null) {
        const error = isAssignableViaStrictTupleTypes(
          getTypeOfNode(leftTypeAnnotation, context),
          getTypeOfNode(rightNode, context),
          context,
        );

        if (error !== null) {
          return assignToArrayErrorIntoDescriptor(declaration, error);
        }
      }

      return null;
    })
    .filter((descriptor) => descriptor !== null);

  return { context, descriptors };
}

function getAllSymbolDeclarations(symbol: Symbol): Declaration[] {
  const decls: Declaration[] = symbol.declarations ?? [];
  const valueDecl = symbol.valueDeclaration;

  if (valueDecl !== undefined) {
    // eslint-disable-next-line functional/immutable-data
    decls.push(valueDecl);
  }

  return decls;
}

type AssignToArrayError = {
  tupleType: string;
  arrayType: string;
};

function assignToArrayErrorIntoDescriptor(
  node: TSESTree.Node,
  error: Readonly<AssignToArrayError>,
): RuleResult<keyof typeof errorMessages, RawOptions>["descriptors"][number] {
  return {
    node,
    messageId: "assignToArray",
    data: {
      tupleType: error.tupleType,
      arrayType: error.arrayType,
    },
  };
}

function weakMapGetOrInsert<K extends WeakKey, V extends null | {}>(weakMap: WeakMap<K, V>, key: K, orElse: () => V): V {
  const value = weakMap.get(key);
  if (value !== undefined) {
    return value;
  }

  const newValue = orElse();
  weakMap.set(key, newValue);
  return newValue;
}

declare const _recursionIdentityBrand: unique symbol;
type RecursionIdentity = { [_recursionIdentityBrand]: true };

const leftToRightToAssignableCache: WeakMap<RecursionIdentity, WeakMap<RecursionIdentity, AssignToArrayError | null>> = new WeakMap();

const setCacheAssignability = (
  checker: TypeChecker,
  leftType: Type,
  rightType: Type,
  error: AssignToArrayError | null,
): void => {
  const leftRi = checker.getRecursionIdentity(leftType);
  const rightTypeToAssignability = weakMapGetOrInsert(leftToRightToAssignableCache, leftRi, () => new WeakMap());
  const rightRi = checker.getRecursionIdentity(rightType);
  rightTypeToAssignability.set(rightRi, error);
};

const getCacheAssignability = (
  checker: TypeChecker,
  leftType: Type,
  rightType: Type,
): AssignToArrayError | null | undefined => {
  const leftRi = checker.getRecursionIdentity(leftType);
  const rightTypeToAssignability = weakMapGetOrInsert(leftToRightToAssignableCache, leftRi, () => new WeakMap());
  const rightRi = checker.getRecursionIdentity(rightType);
  return rightTypeToAssignability.get(rightRi);
};

type TypeScriptTypeChecker = import("typescript").TypeChecker;

// eslint-disable-next-line ts/consistent-type-definitions
interface TypeChecker extends TypeScriptTypeChecker {
  // eslint-disable-next-line functional/prefer-property-signatures
  getRecursionIdentity(type: Type): RecursionIdentity;
}

function isAssignableViaStrictTupleTypes(
  leftType: Type,
  rightType: Type,
  context: Readonly<RuleContext<keyof typeof errorMessages, RawOptions>>,
): AssignToArrayError | null {
  const checker = getParserServices(context).program.getTypeChecker() as TypeChecker;

  // see if we already computed if there's an error
  const cachedError = getCacheAssignability(checker, leftType, rightType);
  if (cachedError !== undefined) {
    return cachedError;
  }

  // otherwise compute it
  const error = (() => {
    // if right is tuple, check if left is too (if so, it's assignable)
    if (checker.isTupleType(rightType)) {
      if (!checker.isTupleType(leftType) && checker.isArrayLikeType(leftType)) {
        return {
          tupleType: checker.typeToString(rightType),
          arrayType: checker.typeToString(leftType),
        };
      }
    }

    // if right is not a tuple, or left & right are both tuples, check properties next
    const leftStringIndexInfo = checker.getIndexInfoOfType(leftType, IndexKind.String);
    const leftNumberIndexInfo = checker.getIndexInfoOfType(leftType, IndexKind.Number);
    const rightProps = checker.getPropertiesOfType(rightType);
    const rightStringIndexInfo = checker.getIndexInfoOfType(rightType, IndexKind.String);
    const rightNumberIndexInfo = checker.getIndexInfoOfType(rightType, IndexKind.Number);

    if (rightStringIndexInfo !== undefined && leftStringIndexInfo !== undefined) {
      const err = isAssignableViaStrictTupleTypes(leftStringIndexInfo.type, rightStringIndexInfo.type, context);
      if (err !== null) {
        return err;
      }
    }

    if (rightNumberIndexInfo !== undefined && leftNumberIndexInfo !== undefined) {
      const err = isAssignableViaStrictTupleTypes(leftNumberIndexInfo.type, rightNumberIndexInfo.type, context);
      if (err !== null) {
        return err;
      }
    }

    // eslint-disable-next-line functional/no-loop-statements
    for (const rightProp of rightProps) {
      const rightPropType = checker.getTypeOfSymbol(rightProp);
      const rightDecls = getAllSymbolDeclarations(rightProp);
      // const rightDecls: Declaration[] = [];

      const leftProp = checker.getPropertyOfType(leftType, rightProp.name);
      const leftPropType = leftProp === undefined ? undefined : checker.getTypeOfSymbol(leftProp);
      const leftDecls = leftProp === undefined ? undefined : getAllSymbolDeclarations(leftProp);
      // const leftDecls: Declaration[] = [];

      // eslint-disable-next-line unicorn/consistent-function-scoping
      const rightIsAssignableToLeftProp = (right: Type): AssignToArrayError | null => {
        if (leftPropType !== undefined) {
          const err = isAssignableViaStrictTupleTypes(leftPropType, right, context);
          if (err !== null) {
            return err;
          }
        }

        if (leftProp !== undefined) {
          if (leftDecls !== undefined) {
            // eslint-disable-next-line functional/no-loop-statements
            for (const leftDecl of leftDecls) {
              const leftDeclType = checker.getTypeOfSymbolAtLocation(leftProp, leftDecl);

              const err = isAssignableViaStrictTupleTypes(leftDeclType, right, context);
              if (err !== null) {
                return err;
              }
            }
          }
        }

        return null;
      };

      rightIsAssignableToLeftProp(rightPropType);

      // eslint-disable-next-line functional/no-loop-statements
      for (const rightDecl of rightDecls) {
        if (!isNamedDeclarationWithName(rightDecl)) {
          continue;
        }

        const rightDeclType = checker.getTypeOfSymbolAtLocation(rightProp, rightDecl);

        const declErr = rightIsAssignableToLeftProp(rightDeclType);
        if (declErr !== null) {
          return declErr;
        }

        if (isStringLiteral(rightDecl.name)) {
          if (leftStringIndexInfo !== undefined) {
            const err = isAssignableViaStrictTupleTypes(leftStringIndexInfo.type, rightDeclType, context);
            if (err !== null) {
              return err;
            }
          }
        } else if (isNumericLiteral(rightDecl.name)) {
          if (leftNumberIndexInfo !== undefined) {
            const err = isAssignableViaStrictTupleTypes(leftNumberIndexInfo.type, rightDeclType, context);
            if (err !== null) {
              return err;
            }
          }
        }
      }
    }

    // no error
    return null;
  })();

  // store error result in cache
  setCacheAssignability(checker, leftType, rightType, error);

  return error;
}

// Create the rule.
export const rule: Rule<keyof typeof errorMessages, RawOptions> = createRule<keyof typeof errorMessages, RawOptions>(
  name,
  meta,
  defaultOptions,
  {
    CallExpression: checkCallExpression,
    AssignmentExpression: checkAssignmentExpression,
    VariableDeclaration: checkVariableDeclaration,
  },
);
