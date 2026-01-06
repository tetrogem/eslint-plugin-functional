import dedent from "dedent";
import { createRuleTester } from "eslint-vitest-rule-tester";
import { describe, expect, it } from "vitest";

import { name, rule } from "#/rules/strict-tuples";

import { typescriptConfig } from "../utils/configs";

describe(name, () => {
  describe("typescript", () => {
    const { valid, invalid } = createRuleTester({
      name,
      rule,
      configs: typescriptConfig,
    });

    it("stress test", async () => {
      await valid({
        code: dedent`
          var x: [number, number] = [5, 6];
          var y: [{ z: [number, number] }] = [{ z: [3, 7] }];
        `,
        options: [],
      });
    });

    it("doesn't report tuple element mutations", async () => {
      await valid({
        code: dedent`
          var x: [number, number] = [5, 6];
          var y: [{ z: [number, number] }] = [{ z: [3, 7] }];
          x[0] = 4;
          y[0].z[0] = 4;
          x[0] += 1;
          y[0].z[0] += 1;
          x[0]++;
          y[0].z[0]++;
          --x[0];
          --y[0].z[0];
          if (x[0] = 2) {}
          if (y[0].z[0] = 2) {}
        `,
        options: [],
      });
    });

    it("report mutating tuple length methods", async () => {
      const invalidResult = await invalid({
        code: dedent`
          var x: [number, number] = [5, 6];
          x.pop();
          x.push(3);
          x.shift();
          x.splice(0, 1, 9);
          x.unshift(6);
          var y: [{ z: [number, number] }] = [{ z: [3, 7] }];
          y[0].z.pop();
          y[0].z.push(3);
          y[0].z.shift();
          y[0].z.splice(0, 1, 9);
          y[0].z.unshift(6);
        `,
        errors: [
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
          "mutateLength",
        ],
      });
      expect(invalidResult.result).toMatchSnapshot();
    });

    it("doesn't report mutating non-length changing tuple methods", async () => {
      await valid({
        code: dedent`
          var x: [number, number] = [5, 6];
          x.copyWithin(0, 1, 2);
          x.fill(3);
          x.reverse();
          x.sort();
          var y: [{ z: [number, number] }] = [{ z: [3, 7] }];
          y[0].z.copyWithin(0, 1, 2);
          y[0].z.fill(3);
          y[0].z.reverse();
          y[0].z.sort();
        `,
      });
    });

    it("doesn't report non-mutating tuple methods", async () => {
      await valid(dedent`
        var x: [number, number] = [5, 6];
        var y: [{ z: [number, number] }] = [{ z: [3, 7] }];

        x.concat([3, 4]);
        x.includes(2);
        x.indexOf(1);
        x.join(', ');
        x.lastIndexOf(0);
        x.slice(1, 2);
        x.toString();
        x.toLocaleString("en", {timeZone: "UTC"});

        y[0].z.concat([3, 4]);
        y[0].z.includes(2);
        y[0].z.indexOf(1);
        y[0].z.join(', ');
        y[0].z.lastIndexOf(0);
        y[0].z.slice(1, 2);
        y[0].z.toString();
        y[0].z.toLocaleString("en", {timeZone: "UTC"});
      `);
    });

    it("doesn't report mutating array methods on non-tuple objects", async () => {
      await valid(dedent`
        var z = {
          pop: function () {},
          push: function () {},
          shift: function () {},
          splice: function () {},
          unshift: function () {}
        };

        z.pop();
        z.push();
        z.shift();
        z.splice();
        z.unshift();
      `);
    });

    it("tuple types can't be assigned to array types", async () => {
      const invalidResult = await invalid({
        code: dedent`
          var tuple: [number, number] = [1, 2];

          var array: number[] = tuple;
          array = tuple;

          var arr2: number[] = tuple, arr3: number[] = tuple;
        `,
        errors: ["assignToArray", "assignToArray", "assignToArray", "assignToArray"],
      });
      expect(invalidResult.result).toMatchSnapshot();
    });

    it("tuple types can't be assigned to nested array types", async () => {
      const invalidResult = await invalid({
        code: dedent`
          var tuple: [number, number] = [1, 2];

          var nested: { nums: number[] } = { nums: tuple };
          nested.nums = tuple;

          var mappedType: { [K in "foo" | "bar"]: number[] } = { "foo": tuple };

          var strIndexSignature: { [x: string]: number[] } = { "foo": tuple };
          var numIndexSignature: { [x: number]: number[] } = { 100: tuple };

          var strIndexSignature2: { [x: string]: number[] } = { "foo": tuple } as { [x: string]: [number, number] };
          var numIndexSignature2: { [x: number]: number[] } = { 100: tuple } as { [x: number]: [number, number] };

          var doubleNested: { foo: number[], bar: { baz: number[] } } = { foo: tuple, bar: { baz: tuple } };
        `,
        errors: [
          "assignToArray",
          "assignToArray",
          "assignToArray",
          "assignToArray",
          "assignToArray",
          "assignToArray",
          "assignToArray",
          "assignToArray",
        ],
      });
      expect(invalidResult.result).toMatchSnapshot();
    });

    it("tuple types can be assigned to nested tuple types", async () => {
      await valid(dedent`
        var tuple: [number, number] = [1, 2];

        var nested: { nums: [number, number] } = { nums: tuple };
        nested.nums = tuple;

        var mappedType: { [K in "foo" | "bar"]: [number, number] } = { "foo": tuple };

        var strIndexSignature: { [x: string]: [number, number] } = { "foo": tuple };
        var numIndexSignature: { [x: number]: [number, number] } = { 100: tuple };

        var strIndexSignature2: { [x: string]: [number, number] } = { "foo": tuple } as { [x: string]: [number, number] };
        var numIndexSignature2: { [x: number]: [number, number] } = { 100: tuple } as { [x: number]: [number, number] };

        var doubleNested: { foo: [number, number], bar: { baz: [number, number] } } = { foo: tuple, bar: { baz: tuple } };
      `);
    });
  });
});
