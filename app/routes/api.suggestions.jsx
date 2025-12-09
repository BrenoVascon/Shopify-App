import db from "../db.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const jsonResponse = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
      ...(init.headers || {}),
    },
  });

export const loader = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return jsonResponse({}, { status: 200 });
  }

  try {
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop");

    if (!shop) {
      return jsonResponse({ error: "Shop parameter required" }, { status: 400 });
    }

    const config = await db.productSuggestionConfig.findUnique({
      where: { shop },
    });

    if (!config) {
      return jsonResponse({ productRelations: {} });
    }

    const productRelations = JSON.parse(config.productRelations || "{}");

    return jsonResponse({ productRelations });
  } catch (error) {
    console.error("Error fetching suggestions config:", error);
    return jsonResponse({ error: error.message }, { status: 500 });
  }
};

