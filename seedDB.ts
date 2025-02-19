import { OpenAIEmbeddings } from "@langchain/openai";
import { MongoClient } from "mongodb";
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb";
import { z } from "zod";
import "dotenv/config";

const client = new MongoClient(process.env.MONGODB_URI as string);

const GasLimitSchema = z.object({
  swap: z.number(),
  transfer: z.number(),
});

const GasLimitGroupSchema = z.object({
  trustless: GasLimitSchema,
  mintBurn: GasLimitSchema,
  circle: GasLimitSchema,
});

const GasTokenSchema = z
  .object({
    symbol: z.string(),
    address: z.string(),
  })
  .nullable();

const ChainSchema = z.object({
  _id: z.string(),
  chainId: z.string(),
  name: z.string(),
  type: z.string(),
  isLive: z.boolean(),
  isIntentApiSupported: z.boolean(),
  isEnabledForMainnet: z.boolean(),
  isRefuelEnabled: z.boolean(),
  isQREnabled: z.boolean(),
  gasLimit: GasLimitGroupSchema.nullable(),
  gasToken: GasTokenSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  __v: z.number(),
});

type Chain = z.infer<typeof ChainSchema>;

interface ApiResponse {
  total: number;
  sortOrder: string;
  sortKey: string;
  page: number;
  limit: number;
  data: Chain[];
}

async function fetchChainData(): Promise<Chain[]> {
  try {
    console.log("Fetching chain data from API...");
    const response = await fetch(
      "https://api.nitroswap.routernitro.com/chain?page=0&limit=50&sortKey=createdAt&sortOrder=asc"
    );

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const rawData = (await response.json()) as ApiResponse;
    console.log(`Fetched ${rawData.data.length} chains from API`);

    // Validate the data against our schema
    const validatedData = rawData.data
      .map((chain) => {
        try {
          return ChainSchema.parse(chain);
        } catch (error) {
          console.warn(`Validation error for chain ${chain.name}:`, error);
          return null;
        }
      })
      .filter((chain): chain is Chain => chain !== null);

    console.log(`Successfully validated ${validatedData.length} chains`);
    return validatedData;
  } catch (error) {
    console.error("Error fetching chain data:", error);
    throw error;
  }
}

async function createSearchableText(chain: Chain): Promise<string> {
  const features = [
    `Intent API: ${chain.isIntentApiSupported ? "Supported" : "Not Supported"}`,
    `Mainnet: ${chain.isEnabledForMainnet ? "Enabled" : "Not Enabled"}`,
    `Refuel: ${chain.isRefuelEnabled ? "Available" : "Not Available"}`,
    `QR: ${chain.isQREnabled ? "Enabled" : "Not Enabled"}`,
  ].join(", ");

  const gasLimits = chain.gasLimit
    ? [
        `Trustless: Swap ${chain.gasLimit.trustless.swap}, Transfer ${chain.gasLimit.trustless.transfer}`,
        `MintBurn: Swap ${chain.gasLimit.mintBurn.swap}, Transfer ${chain.gasLimit.mintBurn.transfer}`,
        `Circle: Swap ${chain.gasLimit.circle.swap}, Transfer ${chain.gasLimit.circle.transfer}`,
      ].join("; ")
    : "No gas limits defined";

  return `
    Chain: ${chain.name} (${chain.type})
    Chain ID: ${chain.chainId}
    Status: ${chain.isLive ? "Live" : "Not Live"}
    Gas Token: ${
      chain.gasToken
        ? `${chain.gasToken.symbol} (${chain.gasToken.address})`
        : "None"
    }
    Features: ${features}
    Gas Limits: ${gasLimits}
    Created: ${chain.createdAt}
    Updated: ${chain.updatedAt}
  `
    .trim()
    .replace(/\n\s+/g, " ");
}

async function seedDatabase(): Promise<void> {
  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    const db = client.db("information_database");
    const collection = db.collection("chaindetails");

    // Clear existing data
    console.log("Clearing existing data...");
    await collection.deleteMany({});

    // Fetch and process chain data
    const chainData = await fetchChainData();

    // Initialize vector store first
    console.log("Initializing vector store...");
    const vectorStore = new MongoDBAtlasVectorSearch(
      new OpenAIEmbeddings({
        modelName: "text-embedding-3-small",
        dimensions: 1536,
      }),
      {
        collection,
        indexName: "vector_index", // Match the index name used in search
        textKey: "text",
        embeddingKey: "embedding",
      }
    );

    // Create documents with enhanced text content and add them directly to vector store
    console.log("Creating documents and embeddings...");
    const documents = await Promise.all(
      chainData.map(async (chain) => {
        const text = await createSearchableText(chain);
        return {
          pageContent: text,
          metadata: {
            ...chain,
            chainId: chain.chainId,
            name: chain.name,
            type: chain.type,
          },
        };
      })
    );

    // Add documents to vector store (this will create embeddings)
    console.log("Adding documents to vector store...");
    await vectorStore.addDocuments(documents);

    console.log(
      `Successfully added ${documents.length} documents with embeddings`
    );

    // Verify embeddings were created
    const sampleDoc = await collection.findOne({});
    if (!sampleDoc?.embedding) {
      console.warn("Warning: Embeddings might not have been created properly");
    } else {
      console.log("Embeddings verified successfully");
    }

    console.log("Successfully completed database seeding");
  } catch (error) {
    console.error("Error in database seeding:", error);
    throw error;
  } finally {
    await client.close();
    console.log("Closed MongoDB connection");
  }
}

// Execute the seeding process
seedDatabase().catch((error) => {
  console.error("Fatal error during seeding:", error);
  process.exit(1);
});
