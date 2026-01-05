import type { TSESTree } from "@typescript-eslint/utils";
import type { JSONSchema4, JSONSchema4ObjectSchema } from "@typescript-eslint/utils/json-schema";
import type { RuleContext } from "@typescript-eslint/utils/ts-eslint";
import { deepmerge } from "deepmerge-ts";
import { isTupleTypeReference } from "ts-api-utils";

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
import { isArrayType, isIdentifier, isMemberExpression } from "#/utils/type-guards";

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
  assignToArray: "Tuple types are not assignable to array types.",
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

  // Tuple length mutation?
  if (
    arrayLengthMutatorMethods.has(node.callee.property.name) &&
    // !isInChainCallAndFollowsNew(node.callee, context) &&
    isTupleTypeReference(getTypeOfNode(node.callee.object, context))
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

  if (
    isArrayType(context, getTypeOfNode(node.left, context)) &&
    isTupleTypeReference(getTypeOfNode(node.right, context))
  ) {
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

  const descriptors = node.declarations
    .map((declaration) => {
      const leftType = declaration.id.typeAnnotation?.typeAnnotation;
      const rightNode = declaration.init;
      if (
        leftType !== undefined &&
        rightNode !== null &&
        isArrayType(context, getTypeOfNode(leftType, context)) &&
        isTupleTypeReference(getTypeOfNode(rightNode, context))
      ) {
        return { node: declaration, messageId: "assignToArray" } as const;
      }

      return null;
    })
    .filter((descriptor) => descriptor !== null);

  return { context, descriptors };
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
