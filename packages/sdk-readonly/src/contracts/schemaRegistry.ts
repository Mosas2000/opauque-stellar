import { ReadOnlyContractClient, addressArg, bytes32Arg, u32Arg } from "../client.js";

export type Schema = {
  authority: string;
  name: string;
  field_definitions: unknown;
  revocable: boolean;
  version: number;
  resolver: string | null;
  schema_expiry_ledger: number;
  deprecated: boolean;
};

/** Typed read methods for the `schema-registry` contract. */
export class SchemaRegistryReadClient {
  constructor(private readonly client: ReadOnlyContractClient) {}

  isAuthorizedIssuer(schemaId: string, issuer: string): Promise<boolean> {
    return this.client.read<boolean>("is_authorized_issuer", [
      bytes32Arg(schemaId),
      addressArg(issuer),
    ]);
  }

  canIssue(schemaId: string, issuer: string): Promise<boolean> {
    return this.client.read<boolean>("can_issue", [bytes32Arg(schemaId), addressArg(issuer)]);
  }

  isRevocable(schemaId: string): Promise<boolean> {
    return this.client.read<boolean>("is_revocable", [bytes32Arg(schemaId)]);
  }

  getSchema(schemaId: string): Promise<Schema> {
    return this.client.read<Schema>("get_schema", [bytes32Arg(schemaId)]);
  }

  getDelegates(schemaId: string, offset: number, limit: number): Promise<string[]> {
    return this.client.read<string[]>("get_delegates", [
      bytes32Arg(schemaId),
      u32Arg(offset),
      u32Arg(limit),
    ]);
  }

  listSchemasByAuthority(
    authority: string,
    offset: number,
    limit: number,
  ): Promise<string[]> {
    return this.client.read<string[]>("list_schemas_by_authority", [
      addressArg(authority),
      u32Arg(offset),
      u32Arg(limit),
    ]);
  }
}
