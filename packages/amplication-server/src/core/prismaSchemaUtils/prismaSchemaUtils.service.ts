import { Inject, Injectable } from "@nestjs/common";
import { validate } from "@prisma/internals";
import {
  getSchema,
  Model,
  Field,
  createPrismaSchemaBuilder,
  ConcretePrismaSchemaBuilder,
  Schema,
} from "@mrleebo/prisma-ast";
import {
  filterOutAmplicationAttributes,
  handleModelName,
  idTypePropertyMap,
} from "./schema-utils";
import { AmplicationLogger } from "@amplication/util/nestjs/logging";
import pluralize from "pluralize";
import {
  CreateEntityFieldInput,
  CreateEntityInput,
  ErrorLevel,
  ErrorMessages,
  Operation,
  SchemaEntityFields,
} from "./types";
import { ErrorMessage } from "./ErrorMessages";

@Injectable()
export class PrismaSchemaUtilsService {
  private operations: Operation[] = [
    this.handleModelNamesRenaming,
    this.handleIdField,
  ];

  constructor(
    @Inject(AmplicationLogger) private readonly logger: AmplicationLogger
  ) {}

  prepareSchema =
    (...operations: Operation[]) =>
    (initialSchema: string): Schema => {
      let builder = createPrismaSchemaBuilder(initialSchema);

      operations.forEach((operation) => {
        builder = operation.call(this, builder);
      });

      return builder.getSchema();
    };

  prepareEntitiesWithFields(schema: string): SchemaEntityFields[] {
    const preparedSchema = this.prepareSchema(...this.operations)(schema);
    this.debugSchema(preparedSchema);
    const preparedEntities = preparedSchema.list
      .filter((item: Model) => item.type === "model")
      .map((model: Model) => {
        const entity = this.prepareEntity(model);
        const fields = this.prepareEntityFields(model);

        const preparedEntityWithFields: SchemaEntityFields = {
          ...entity,
          fields: fields,
        };

        return preparedEntityWithFields;
      });

    return preparedEntities;
  }

  prepareEntity(model: Model): CreateEntityInput {
    const modelAttributes = model.properties.filter(
      (prop) => prop.type === "attribute"
    );
    const entityPluralDisplayName = pluralize(model.name);
    const entityAttributes = this.prepareAttributes(modelAttributes);

    return {
      name: model.name,
      displayName: model.name,
      pluralDisplayName: entityPluralDisplayName,
      description: null,
      customAttributes: entityAttributes,
    };
  }

  prepareEntityFields(model: Model): CreateEntityFieldInput[] {
    const modelFields = model.properties.filter(
      (prop) => prop.type === "field"
    );
    return modelFields.map((field: Field) => {
      const isUniqueField = field.attributes?.some(
        (attr) => attr.name === "unique"
      );
      const fieldProperties = this.prepareFiledProperties(field);
      const fieldAttributes = filterOutAmplicationAttributes(
        this.prepareAttributes(field.attributes)
      );
      return {
        name: field.name,
        displayName: field.name,
        dataType: field.type,
        required: field.optional,
        unique: isUniqueField,
        searchable: false,
        description: null,
        properties: fieldProperties,
        customAttributes: fieldAttributes,
      };
    });
  }

  /**
   * add "@@map" attribute to model name if its name is plural or snake case
   * and rename model name to singular and in pascal case
   * @param builder - prisma schema builder
   * @returns
   */
  private handleModelNamesRenaming(
    builder: ConcretePrismaSchemaBuilder
  ): ConcretePrismaSchemaBuilder {
    const schema = builder.getSchema();
    const models = schema.list.filter((item) => item.type === "model");
    models.map((model: Model) => {
      const isInvalidModelName =
        pluralize.isPlural(model.name) || model.name.includes("_");
      if (isInvalidModelName) {
        builder.model(model.name).blockAttribute("map", model.name);
        builder.model(model.name).then<Model>((model) => {
          model.name = handleModelName(model.name);
        });
        return builder.getSchema();
      }
    });
    return builder;
  }

  /**
   * search for the id of the table (decorated with @id) and if it is not named "id" rename it to "id" and add "@map" attribute
   * @param builder - prisma schema builder
   */
  private handleIdField(
    builder: ConcretePrismaSchemaBuilder
  ): ConcretePrismaSchemaBuilder {
    const schema = builder.getSchema();
    const models = schema.list.filter((item) => item.type === "model");
    models.map((model: Model) => {
      const idField = model.properties.find(
        (property) =>
          property.type === "field" &&
          property.attributes?.some((attr) => attr.name === "id")
      ) as Field;
      if (idField && idField.name !== "id") {
        builder
          .model(model.name)
          .field(idField.name)
          .attribute("map", [idField.name]);
        builder
          .model(model.name)
          .field(idField.name)
          .then<Field>((field) => {
            field.name = "id";
          });
        return builder.getSchema();
      }
    });
    return builder;
  }

  /**
   * take the model or field attributes from the schema object and translate it to array of strings like Amplication expects
   * @param attributes
   * @returns array of strings representing the attributes
   */
  private prepareAttributes(attributes): string[] {
    if (!attributes && !attributes?.length) {
      return [];
    }
    return attributes.map((attribute) => {
      if (!attribute.args && !attribute.args?.length) {
        return attribute.kind === "model"
          ? `@@${attribute.name}`
          : `@${attribute.name}`;
      }
      const args = attribute.args.map((arg) => {
        if (typeof arg.value === "object" && arg.value !== null) {
          if (arg.value.type === "array") {
            return `[${arg.value.args.join(", ")}]`;
          } else if (arg.value.type === "keyValue") {
            return `${arg.value.key}: ${arg.value.value}`;
          }
        } else {
          return arg.value;
        }
      });

      return `${attribute.kind === "model" ? "@@" : "@"}${
        attribute.name
      }(${args.join(", ")})`;
    });
  }

  private prepareFiledProperties(field) {
    const defaultIdAttribute = field.attributes?.find(
      (attr) => attr.name === "default"
    );
    if (!defaultIdAttribute) return;
    return idTypePropertyMap[defaultIdAttribute.args[0].value.name];
  }

  validateSchemaProcessing(schema: string): ErrorMessage[] | null {
    const schemaObject = getSchema(schema);
    const errors: ErrorMessage[] = [];
    const models = schemaObject.list.filter(
      (item: Model) => item.type === "model"
    );

    if (models.length === 0) {
      errors.push({
        message: ErrorMessages.NoModels,
        level: ErrorLevel.Error,
        details: "A schema must contain at least one model",
      });
    }

    return errors.length > 0 ? errors : null;
  }

  validateSchemaUpload(file: string): void {
    const schemaString = file.replace(/\\n/g, "\n");
    try {
      validate({ datamodel: schemaString });
      this.logger.info("Valid schema");
    } catch (error) {
      this.logger.error("Invalid schema", error);
      throw new Error("Invalid schema");
    }
  }
}
