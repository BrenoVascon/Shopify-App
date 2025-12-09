import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useSubmit, useNavigation, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }) => {
  try {
    const { session } = await authenticate.admin(request);
    const shop = session.shop;

    let productRelations = {};

    try {
      const config = await db.productSuggestionConfig.findUnique({
        where: { shop }
      });

      if (config && config.productRelations) {
        productRelations = JSON.parse(config.productRelations);
      }
    } catch (dbError) {
      console.error("Database error:", dbError);
    }

    return Response.json({
      shop,
      productRelations,
    });
  } catch (error) {
    console.error("Loader error:", error);
    return Response.json({
      shop: "",
      productRelations: {},
    });
  }
};

export const action = async ({ request }) => {
  try {
    const { session, admin } = await authenticate.admin(request);
    const shop = session.shop;

    const formData = await request.formData();
    const productRelations = formData.get("productRelations");

    await db.productSuggestionConfig.upsert({
      where: { shop },
      update: {
        selectedProducts: "[]",
        productRelations,
        updatedAt: new Date(),
      },
      create: {
        shop,
        selectedProducts: "[]",
        productRelations,
      },
    });

    const metafieldErrors = [];
    try {
      const parsed = JSON.parse(productRelations || "{}");
      const entries = Object.entries(parsed);

      for (const [mainProductId, data] of entries) {
        const relatedIds =
          (data?.related || [])
            .map((r) => r.id)
            .filter(Boolean);

        if (!relatedIds.length) continue;

        const metafields = [
          {
            ownerId: mainProductId,
            namespace: "custom",
            key: "related_products",
            type: "list.product_reference",
            value: JSON.stringify(relatedIds),
          },
        ];

        const resp = await admin.graphql(
          `mutation SetRelatedProducts($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors { field message }
            }
          }`,
          {
            variables: { metafields },
          }
        );

        const result = await resp.json();
        const errors =
          result?.data?.metafieldsSet?.userErrors ||
          result?.errors ||
          [];
        if (errors.length) {
          console.error("Metafield set errors", errors);
          metafieldErrors.push({ mainProductId, errors });
        }
      }
    } catch (mfError) {
      console.error("Metafield update error:", mfError);
      metafieldErrors.push({ message: mfError?.message || "Metafield update error" });
    }

    return Response.json({ success: metafieldErrors.length === 0, metafieldErrors });
  } catch (error) {
    console.error("Action error:", error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
};

export default function ProductSuggestionConfig() {
  const { productRelations: initialRelations } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const shopify = useAppBridge();

  const [productRelations, setProductRelations] = useState(initialRelations);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedProducts, setExpandedProducts] = useState(new Set());

  const isLoading = navigation.state === "submitting";

  useEffect(() => {
    const productIds = Object.keys(initialRelations);
    const withRelated = productIds.filter(id => {
      const relation = initialRelations[id];
      return relation?.related && relation.related.length > 0;
    });
    setExpandedProducts(new Set(withRelated));
  }, [initialRelations]);

  const toggleProductExpanded = useCallback((productId) => {
    setExpandedProducts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(productId)) {
        newSet.delete(productId);
      } else {
        newSet.add(productId);
      }
      return newSet;
    });
  }, []);


  const handleSearchProductsAndAdd = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
    });

    if (selected && selected.length) {
      setProductRelations(prev => {
        const updated = { ...prev };
        selected.forEach(item => {
          if (!updated[item.id]) {
            updated[item.id] = {
              product: {
                id: item.id,
                title: item.title,
                handle: item.handle,
                images: item.images,
              },
              related: [],
            };
          }
        });
        return updated;
      });
      shopify.toast.show("Produtos adicionados como principais.");
    }
  }, [shopify]);

  const handleSelectRelatedProducts = useCallback(async (mainProductId) => {
    const currentRelated = productRelations[mainProductId]?.related || [];
    const mainProduct = productRelations[mainProductId]?.product;

    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: true,
      action: "select",
      selectionIds: currentRelated.map(p => ({ id: p.id })),
    });

    if (selected) {
      const relatedProducts = selected.map(item => ({
        id: item.id,
        title: item.title,
        handle: item.handle,
        images: item.images,
      }));

      setProductRelations(prev => ({
        ...prev,
        [mainProductId]: {
          product: mainProduct || {
            id: mainProductId,
            title: "",
            handle: "",
            images: [],
          },
          related: relatedProducts,
        }
      }));

      shopify.toast.show("Produtos relacionados atualizados!");
    }
  }, [shopify, productRelations]);

  const handleRemoveMainProduct = useCallback((productId) => {
    setProductRelations(prev => {
      const newRelations = { ...prev };
      delete newRelations[productId];
      return newRelations;
    });
  }, []);

  const handleRemoveRelatedProduct = useCallback((mainProductId, relatedProductId) => {
    setProductRelations(prev => {
      const current = prev[mainProductId];
      if (!current) return prev;

      const filteredRelated = (current.related || []).filter(
        (p) => p.id !== relatedProductId
      );

      return {
        ...prev,
        [mainProductId]: {
          ...current,
          related: filteredRelated,
        },
      };
    });
  }, []);


  const handleSave = useCallback(() => {
    const formData = new FormData();
    formData.append("productRelations", JSON.stringify(productRelations));
    submit(formData, { method: "POST" });
    shopify.toast.show("Configuração salva com sucesso!");
  }, [productRelations, submit, shopify]);

  const mainProducts = Object.keys(productRelations);
  const filteredProducts = mainProducts.filter(productId => {
    const relation = productRelations[productId];
    const mainProduct = relation.product;
    return (
      mainProduct.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      mainProduct.handle.toLowerCase().includes(searchQuery.toLowerCase())
    );
  });

  return (
    <s-page heading="Produtos Relacionados no Checkout" fullWidth>
      <s-button
        slot="primary-action"
        onClick={handleSave}
        variant="primary"
        {...(isLoading ? { loading: true } : {})}
      >
        Salvar Configuração
      </s-button>

      <s-section>
        <s-stack gap="large-200">
          <s-banner tone="info">
            <s-stack gap="tight">
              <s-text emphasis="bold">Como funciona</s-text>
              <s-text size="small">
                Configure produtos relacionados que aparecerão como sugestões no checkout quando o cliente adicionar produtos principais ao carrinho.
              </s-text>
            </s-stack>
          </s-banner>

          <s-stack gap="base">
            <s-grid gap="base" columns="1fr auto" alignItems="center">
              <s-heading level={2}>Adicionar Produtos</s-heading>
              {mainProducts.length > 0 && (
                <s-box padding="tight" background="info" borderRadius="base">
                  <s-text size="small" emphasis="bold" color="base">
                    {mainProducts.length} configurado{mainProducts.length !== 1 ? 's' : ''}
                  </s-text>
                </s-box>
              )}
            </s-grid>

            <s-button onClick={handleSearchProductsAndAdd} variant="primary">
              + Adicionar Produtos Principais
            </s-button>
          </s-stack>

          {mainProducts.length > 0 && (
            <s-stack gap="base">
              <s-grid gap="base" columns="1fr auto" alignItems="center">
                <s-heading level={2}>Relações Configuradas</s-heading>
                <s-box padding="tight" background="success" borderRadius="base">
                  <s-text size="small" emphasis="bold" color="base">
                    {mainProducts.length}
                  </s-text>
                </s-box>
              </s-grid>

              <s-text-field
                label="Buscar produto"
                value={searchQuery}
                onInput={(e) => setSearchQuery(e.target.value)}
                placeholder="Digite o nome ou handle do produto..."
                clearButton
                onClearButtonClick={() => setSearchQuery("")}
              />

              {filteredProducts.length === 0 ? (
                <s-box padding="large" background="subdued" borderRadius="base">
                  <s-stack gap="tight" alignment="center">
                    <s-text emphasis="bold">Nenhum produto encontrado</s-text>
                    <s-text color="subdued">Tente outro termo de busca</s-text>
                  </s-stack>
                </s-box>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {filteredProducts.map((productId) => {
                    const relation = productRelations[productId];
                    const mainProduct = relation.product;
                    const relatedProducts = relation.related || [];

                    return (
                      <s-box
                        key={productId}
                        padding="base"
                        borderWidth="base"
                        borderRadius="base"
                        background="base"
                      >
                        <s-stack gap="base">
                          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                            {mainProduct.images?.[0]?.originalSrc && (
                              <img
                                src={mainProduct.images[0].originalSrc}
                                alt={mainProduct.title}
                                style={{
                                  width: "80px",
                                  height: "80px",
                                  objectFit: "cover",
                                  borderRadius: "8px",
                                  border: "1px solid #e1e3e5",
                                  flexShrink: 0
                                }}
                              />
                            )}

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1 }}>
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                <s-text emphasis="bold" size="large">
                                  {mainProduct.title}
                                </s-text>
                                {relatedProducts.length > 0 && (
                                  <s-box padding="tight" background="success" borderRadius="base">
                                    <s-text size="small" emphasis="bold" color="base">
                                      {relatedProducts.length}
                                    </s-text>
                                  </s-box>
                                )}
                              </div>
                              <s-text color="subdued" size="small">
                                Produto Principal
                              </s-text>
                            </div>

                            <s-button
                              variant="secondary"
                              onClick={() => handleRemoveMainProduct(productId)}
                            >
                              Remover
                            </s-button>
                          </div>

                          <s-divider />

                          <s-stack gap="tight">
                            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', justifyContent: 'space-between' }}>
                              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                <s-button
                                  variant="plain"
                                  onClick={() => toggleProductExpanded(productId)}
                                  disabled={relatedProducts.length === 0}
                                  style={{
                                    minWidth: "32px",
                                    padding: "4px 8px",
                                    opacity: relatedProducts.length === 0 ? 0.5 : 1
                                  }}
                                >
                                  <svg
                                    width="20"
                                    height="20"
                                    viewBox="0 0 20 20"
                                    fill="none"
                                    xmlns="http://www.w3.org/2000/svg"
                                    style={{
                                      transform: expandedProducts.has(productId) ? 'rotate(180deg)' : 'rotate(0deg)',
                                      transition: 'transform 0.2s ease'
                                    }}
                                  >
                                    <path
                                      d="M5 7.5L10 12.5L15 7.5"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                </s-button>
                                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                  <s-text emphasis="bold">Produtos Relacionados</s-text>
                                  {relatedProducts.length > 0 && (
                                    <s-box padding="tight" background="subdued" borderRadius="base">
                                      <s-text size="small" emphasis="bold">
                                        {relatedProducts.length} produto{relatedProducts.length !== 1 ? 's' : ''}
                                      </s-text>
                                    </s-box>
                                  )}
                                </div>
                              </div>

                              <s-button
                                onClick={() => handleSelectRelatedProducts(productId)}
                                variant="secondary"
                              >
                                {relatedProducts.length > 0 ? "Alterar" : "+ Adicionar"}
                              </s-button>
                            </div>

                            {relatedProducts.length > 0 && expandedProducts.has(productId) && (
                              <s-box padding="base" background="subdued" borderRadius="base">
                                <div style={{
                                  display: 'flex',
                                  flexWrap: 'wrap',
                                  gap: '16px'
                                }}>
                                  {relatedProducts.map((related) => (
                                    <s-box
                                      key={related.id}
                                      padding="base"
                                      background="base"
                                      borderRadius="base"
                                      borderWidth="base"
                                      style={{ flex: '1 1 280px', minWidth: '280px', maxWidth: '100%' }}
                                    >
                                      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                                        {related.images?.[0]?.originalSrc && (
                                          <img
                                            src={related.images[0].originalSrc}
                                            alt={related.title}
                                            style={{
                                              width: "64px",
                                              height: "64px",
                                              objectFit: "cover",
                                              borderRadius: "8px",
                                              border: "1px solid #e1e3e5",
                                              flexShrink: 0
                                            }}
                                          />
                                        )}
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: 1, minWidth: 0 }}>
                                          <s-text size="medium" emphasis="bold">{related.title}</s-text>
                                          <s-text color="subdued" size="small">
                                            {related.handle}
                                          </s-text>
                                        </div>
                                        <s-button
                                          variant="plain"
                                          onClick={() => handleRemoveRelatedProduct(productId, related.id)}
                                          style={{ flexShrink: 0 }}
                                        >
                                          ✕
                                        </s-button>
                                      </div>
                                    </s-box>
                                  ))}
                                </div>
                              </s-box>
                            )}
                          </s-stack>
                        </s-stack>
                      </s-box>
                    );
                  })}
                </div>
              )}
            </s-stack>
          )}

          {mainProducts.length === 0 && (
            <s-box padding="extra-large" background="subdued" borderRadius="base">
              <s-stack gap="base" alignment="center">
                <s-text emphasis="bold" size="large">
                  Nenhuma relação configurada
                </s-text>
                <s-text color="subdued" alignment="center">
                  Clique em &quot;Adicionar Produtos Principais&quot; para começar a configurar suas relações de produtos
                </s-text>
                <s-button onClick={handleSearchProductsAndAdd} variant="primary">
                  Começar Agora
                </s-button>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
