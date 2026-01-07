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

          var toUnion: number[] | null = tuple;
          var fromUnion: number[] | null | undefined = tuple as [number, number] | null;
        `,
        errors: ["assignToArray", "assignToArray", "assignToArray", "assignToArray", "assignToArray", "assignToArray"],
      });
      expect(invalidResult.result).toMatchSnapshot();
    });

    it("tuple types can be assigned to tuple types", async () => {
      await valid({
        code: dedent`
          var tuple: [number, number] = [1, 2];

          var array: [number, number] = tuple;
          array = tuple;

          var arr2: [number, number] = tuple, arr3: [number, number] = tuple;

          var toUnion: [number, number] | null = tuple;
          var fromUnion: [number, number] | null | undefined = tuple as [number, number] | null;
        `,
      });
    });

    it("tuple types can't be assigned to nested array types", async () => {
      const invalidResult = await invalid({
        code: dedent`
          var tuple: [number, number] = [1, 2];

          var nested: { nums: number[] } = { nums: tuple };
          nested.nums = tuple;

          var mappedType: { [K in "foo" | "bar"]?: number[] } = { "foo": tuple };

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

        var mappedType: { [K in "foo" | "bar"]?: [number, number] } = { "foo": tuple };

        var strIndexSignature: { [x: string]: [number, number] } = { "foo": tuple };
        var numIndexSignature: { [x: number]: [number, number] } = { 100: tuple };

        var strIndexSignature2: { [x: string]: [number, number] } = { "foo": tuple } as { [x: string]: [number, number] };
        var numIndexSignature2: { [x: number]: [number, number] } = { 100: tuple } as { [x: number]: [number, number] };

        var doubleNested: { foo: [number, number], bar: { baz: [number, number] } } = { foo: tuple, bar: { baz: tuple } };
      `);
    });

    describe("stress tests", () => {
      it("cyclic types", async () => {
        await valid({
          code: dedent`
            interface A<T> {
              value: T,
              b: B;
            }

            interface B<T> {
              a: A<T> | null;
            }

            // make the rhs type opaque (black box)
            var a: A<[number, number]> = { value: [1, 2], b: { a: null } } as A<[number, number]>;
            a.b.a = a;
          `,
          options: [],
        });
      });

      it("deep types", async () => {
        const invalidResult = await invalid({
          code: dedent`
            interface ManyProps<T> {
              a?: T;
              b?: [number, T];
              c?: [string, T];
              d?: [boolean, T];
              e?: [bigint, T];
              f?: [symbol, T];
              g?: T[];
              h?: () => T;
              i?: (x: number) => T;
              j?: (x: string) => T;
              k?: (x: boolean) => T;
              l?: (x: bigint) => T;
              m?: (x: symbol) => T;
              n?: (x: number, y: number) => T;
              o?: (x: string, y: string) => T;
              p?: (x: boolean, y: boolean) => T;
              q?: (x: bigint, y: bigint) => T;
              r?: (x: symbol, y: symbol) => T;
              s?: (x: null, y: null) => T;
              t?: T[][];
              u?: T[][][];
              v?: (() => T)[];
              w?: (() => () => T)[];
              x?: (() => () => () => T)[];
              y?: { t: T };
              z?: { t: { t: T } };
            }

            type DeepMap<T, U> = {
                value?: U,
                props?: ManyProps<T>,
            }

            type DeepMapper<T, US> = US extends [infer U, ...infer URest] ? DeepMapper<DeepMap<T, U>, URest> : T;

            // add new entries to the array to test how deep it can handle within ~2s
            // (not 10s because it may slow down when running all tests)
            type Deepify<T> = DeepMapper<T, ["A", "B", "C", "D", "E"]>;

            var foo: Deepify<{ foo: [number] }> = {} as Deepify<{ foo: [number] }>;
            var bar: Deepify<{ foo: number[] }> = foo;
          `,
          options: [],
          errors: ["assignToArray"],
        });
        expect(invalidResult.result).toMatchSnapshot();
      });
    });
  });
});
