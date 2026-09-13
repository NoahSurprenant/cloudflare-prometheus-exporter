import { initGraphQLTada } from "gql.tada";
import type { introspection } from "./graphql-env";

export const graphql = initGraphQLTada<{
	introspection: introspection;
	scalars: {
		Date: string;
		DateTime: string;
		Time: string;
		bytes: string;
		float32: number;
		float64: number;
		string: string;
		uint8: number;
		uint16: number;
		uint32: number;
		uint64: number;
	};
}>();

export type { FragmentOf, ResultOf, VariablesOf } from "gql.tada";
