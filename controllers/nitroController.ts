import fetch from "node-fetch";

export const getChainDetails = async (chainQuery: string) => {
  try {
    const ROUTER_NITRO_API = "https://api.nitroswap.routernitro.com/chain";
    const searchParams = new URLSearchParams({
      page: "0",
      limit: "200",
      sortKey: "createdAt",
      sortOrder: "asc",
    });

    console.log(
      "🔄 Fetching chain details from RouterNitro:",
      `${ROUTER_NITRO_API}?${searchParams}`
    );

    const response = await fetch(`${ROUTER_NITRO_API}?${searchParams}`, {
      headers: {
        Accept: "application/json",
        "User-Agent": "RouterNitro API Client",
      },
    });

    if (!response.ok) {
      throw new Error(
        `RouterNitro API error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    console.log("📥 Raw RouterNitro Response:", JSON.stringify(data, null, 2));

    if (!data.data || !Array.isArray(data.data)) {
      throw new Error("Invalid API response format");
    }

    // Find chains that match the search term (case insensitive)
    const searchTerm = chainQuery.toLowerCase();
    const matchingChains = data.data.filter(
      (chain: any) =>
        chain.name?.toLowerCase().includes(searchTerm) ||
        chain.chainId?.toLowerCase().includes(searchTerm) ||
        chain.type?.toLowerCase().includes(searchTerm) ||
        chain.gasToken?.symbol?.toLowerCase().includes(searchTerm)
    );

    // Process and format the chain data
    const processedData = matchingChains.map((chain: any) => ({
      chain: {
        name: chain.name || "Unknown",
        chainId: chain.chainId || "Unknown",
        type: chain.type || "Unknown",
        isLive: chain.isLive || false,
      },
      gas: {
        token: chain.gasToken || null,
        limits: chain.gasLimit || {},
      },
      features: {
        isIntentApiSupported: chain.isIntentApiSupported || false,
        isRefuelEnabled: chain.isRefuelEnabled || false,
        isQREnabled: chain.isQREnabled || false,
      },
      metadata: {
        createdAt: chain.createdAt || null,
        updatedAt: chain.updatedAt || null,
      },
      url: `https://routernitro.com/chain/${chain.chainId}`,
      timestamp: new Date().toISOString(),
    }));

    return {
      success: true,
      data: processedData,
      message:
        processedData.length > 0
          ? `Found ${processedData.length} matching chains`
          : "No matching chains found",
      timestamp: new Date().toISOString(),
      source: "RouterNitro",
      count: processedData.length,
    };
  } catch (error) {
    console.error("❌ Error fetching chain details:", error);
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return {
      success: false,
      data: null,
      message: errorMessage,
      timestamp: new Date().toISOString(),
      source: "RouterNitro",
    };
  }
};
