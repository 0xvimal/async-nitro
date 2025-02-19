import { tool } from "@langchain/core/tools";
import { z } from "zod";
import fetch from "node-fetch";
import { getChainDetails } from "../controllers/nitroController";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";

// Define schemas for better type safety and documentation
const TransactionDetailsSchema = z.object({
  fromChain: z.string().describe("Source blockchain name"),
  toChain: z.string().describe("Destination blockchain name"),
  amount: z.string().describe("Amount to transfer/swap"),
  fromToken: z.string().describe("Source token symbol"),
  toToken: z.string().describe("Destination token symbol"),
});

const TokenDetailsSchema = z.object({
  symbol: z.string(),
  address: z.string(),
  decimals: z.number(),
  chainId: z.string(),
});

const QuoteResponseSchema = z.object({
  estimatedGas: z.number(),
  route: z.array(z.any()),
  expectedOutput: z.string(),
  priceImpact: z.string(),
});

// Initialize ChatGPT for parameter extraction
const llm = new ChatOpenAI({
  modelName: "gpt-4o",
  temperature: 0,
});

// Create a chat prompt template for parameter extraction
const chatPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    "You are a helpful assistant that extracts transaction parameters from user queries about token swapping or bridging. Always return a valid JSON object with the required fields.",
  ],
  [
    "human",
    "Extract the following parameters from this query: {input}\n\nReturn a JSON object with these fields:\n- fromChain: Source blockchain name\n- toChain: Destination blockchain name\n- amount: Numeric amount to transfer\n- fromToken: Source token symbol\n- toToken: Destination token symbol\n\nIf a field is not explicitly mentioned, infer it from context. For example:\n- If a token is mentioned with an amount (e.g., '1 ETH'), that's the fromToken\n- If only one token is mentioned, use it as both fromToken and toToken\n- If no toToken is specified but a toChain is, try to use the same token symbol",
  ],
  ["assistant", "I'll extract the parameters and return them in JSON format."],
  ["human", "Remember to return ONLY the JSON object, no additional text."],
]);

// Helper function to extract transaction details using LLM
const extractTransactionDetails = async (query: string) => {
  try {
    const result = await llm.invoke([
      {
        role: "system",
        content:
          "Extract transaction parameters and return them as a JSON object.",
      },
      {
        role: "user",
        content: `Extract transaction parameters from this query: "${query}"\n\nReturn ONLY a JSON object with these fields:\n- fromChain\n- toChain\n- amount\n- fromToken\n- toToken`,
      },
    ]);

    // Parse the JSON response
    let extractedData;
    try {
      const content = result.content;
      if (typeof content === "string") {
        // Find the JSON object in the string
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          extractedData = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error("No JSON object found in LLM response");
        }
      } else {
        extractedData = content;
      }

      console.log("Raw LLM response:", result.content);
      console.log("Extracted data before validation:", extractedData);

      return TransactionDetailsSchema.parse(extractedData);
    } catch (parseError) {
      const errorMessage =
        parseError instanceof Error
          ? parseError.message
          : "Unknown parsing error";
      console.error("Error parsing LLM response:", errorMessage);
      throw new Error(`Failed to parse transaction details: ${errorMessage}`);
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.error("Error extracting transaction details:", errorMessage);
    throw new Error(
      `Failed to extract transaction parameters: ${errorMessage}`
    );
  }
};

// Helper function to get token details
const getTokenDetails = async (chainId: string, tokenSymbol: string) => {
  try {
    const ROUTER_NITRO_TOKEN_API = `https://api.nitroswap.routernitro.com/token/${chainId}`;
    const response = await fetch(ROUTER_NITRO_TOKEN_API, {
      headers: {
        Accept: "application/json",
        "User-Agent": "RouterNitro API Client",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Token API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    const tokens = data.data || [];
    const token = tokens.find(
      (t: any) => t.symbol.toLowerCase() === tokenSymbol.toLowerCase()
    );
    console.log("Token details:", token);
    return token ? TokenDetailsSchema.parse(token) : null;
  } catch (error) {
    console.error("Error fetching token details:", error);
    return null;
  }
};

// Helper function to get transaction details
const getTransactionDetails = async (params: {
  fromChainId: string;
  toChainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
}) => {
  try {
    const ROUTER_NITRO_QUOTE_API =
      "https://api.nitroswap.routernitro.com/quote";
    const response = await fetch(ROUTER_NITRO_QUOTE_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "RouterNitro API Client",
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      throw new Error(
        `Quote API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    return QuoteResponseSchema.parse(data);
  } catch (error) {
    console.error("Error fetching transaction details:", error);
    return null;
  }
};

export const nitro = tool(
  async ({ query }: { query: string }) => {
    try {
      console.log("Processing query:", query);

      // Step 1: Extract transaction details from query using LLM
      const details = await extractTransactionDetails(query);

      console.log("Extracted details:", details);

      // Step 2: Get chain details
      const [fromChainResult, toChainResult] = await Promise.all([
        getChainDetails(details.fromChain),
        getChainDetails(details.toChain),
      ]);

      if (!fromChainResult.success || !toChainResult.success) {
        return [
          "Failed to fetch chain details. Please check the chain names and try again.",
          {
            error: "Invalid chain information",
            details: { fromChainResult, toChainResult },
          },
        ];
      }

      const fromChain = fromChainResult.data[0]?.chain;
      const toChain = toChainResult.data[0]?.chain;

      // Step 3: Get token details
      const [fromToken, toToken] = await Promise.all([
        getTokenDetails(fromChain.chainId, details.fromToken),
        getTokenDetails(toChain.chainId, details.toToken),
      ]);

      if (!fromToken || !toToken) {
        return [
          "Failed to fetch token details. Please check the token symbols and try again.",
          {
            error: "Invalid token information",
            details: { fromToken, toToken },
          },
        ];
      }

      // Step 4: Get transaction details
      const transactionDetails = await getTransactionDetails({
        fromChainId: fromChain.chainId,
        toChainId: toChain.chainId,
        fromTokenAddress: fromToken.address,
        toTokenAddress: toToken.address,
        amount: details.amount,
      });

      if (!transactionDetails) {
        return [
          "Failed to fetch quote. Please try again with different parameters.",
          { error: "Error getting quote" },
        ];
      }

      // Step 5: Format and return the response
      const humanReadableResponse = `Found route to ${details.toToken} on ${details.toChain} chain:
- Amount: ${details.amount} ${details.fromToken}
- Expected output: ${transactionDetails.expectedOutput} ${details.toToken}
- Price impact: ${transactionDetails.priceImpact}
- Estimated gas: ${transactionDetails.estimatedGas}`;

      return [
        humanReadableResponse,
        {
          fromChain,
          toChain,
          fromToken,
          toToken,
          amount: details.amount,
          quote: transactionDetails,
        },
      ];
    } catch (error) {
      console.error("Error in nitro tool:", error);
      return [
        "An error occurred while processing your request. Please try again.",
        {
          error: error instanceof Error ? error.message : "Unknown error",
          query,
        },
      ];
    }
  },
  {
    name: "nitro",
    description:
      "Get detailed information about buying or selling tokens on different blockchain using RouterNitro bridge. " +
      "Provide the from chain, to chain, amount, from token, to token. " +
      "Returns the transaction details. " +
      "Use this when users ask about buying, selling, bridging or swapping tokens on different blockchain using RouterNitro bridge.",
    schema: z.object({
      query: z
        .string()
        .describe(
          "The query describing the token swap/bridge operation in natural language, e.g., 'I want to swap 100 ETH from Ethereum to Bitcoin', or 'Bridge 50 USDT from BSC to Polygon'"
        ),
    }),
    responseFormat: "content_and_artifact",
  }
);
