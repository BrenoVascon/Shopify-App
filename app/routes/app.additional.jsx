import { useState, useCallback } from "react";
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
  const [selectedMainProduct, setSelectedMainProduct] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");

  const isLoading = navigation.state === "submitting";

  const handleSelectMainProduct = useCallback(async () => {
    const selected = await shopify.resourcePicker({
      type: "product",
      multiple: false,
      action: "select",
    });

    if (selected && selected.length > 0) {
      const product = selected[0];
      setSelectedMainProduct({
        id: product.id,
        title: product.title,
        handle: product.handle,
        images: product.images,
      });
    }
  }, [shopify]);

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
          product: mainProduct || selectedMainProduct || {
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
  }, [shopify, productRelations, selectedMainProduct]);

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

  const handleAddRelation = useCallback(() => {
    if (!selectedMainProduct) return;

    if (!productRelations[selectedMainProduct.id]) {
      setProductRelations(prev => ({
        ...prev,
        [selectedMainProduct.id]: {
          product: selectedMainProduct,
          related: []
        }
      }));
    }

    setSelectedMainProduct(null);
  }, [selectedMainProduct, productRelations]);

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
    <s-page heading="Configurar Produtos Relacionados no Checkout">
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
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="tight">
              <s-text emphasis="bold">Como funciona?</s-text>
              <s-text>
                1. Adicione um produto principal (que o cliente coloca no carrinho)
              </s-text>
              <s-text>
                2. Configure quais produtos devem aparecer como sugestão quando esse produto estiver no carrinho
              </s-text>
              <s-text>
                3. Repita para cada produto que você quer criar relações
              </s-text>
              <s-text>
                4. Clique em Salvar Configuração para aplicar
              </s-text>
            </s-stack>
          </s-box>

          <s-stack gap="base">
            <s-heading level={2}>Adicionar Nova Relação</s-heading>

            <s-stack gap="tight">
              {!selectedMainProduct ? (
                <s-grid columns="auto auto" gap="tight">
                  <s-button onClick={handleSearchProductsAndAdd} variant="primary">
                    Buscar e adicionar produtos
                  </s-button>
                </s-grid>
              ) : (
                <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
                  <s-grid gap="base" columns="auto 1fr auto" alignItems="center">
                    {selectedMainProduct.images?.[0]?.originalSrc && (
                      <img
                        src={selectedMainProduct.images[0].originalSrc}
                        alt={selectedMainProduct.title}
                        style={{
                          width: "48px",
                          height: "48px",
                          objectFit: "cover",
                          borderRadius: "8px",
                          border: "1px solid #e1e3e5"
                        }}
                      />
                    )}
                    <s-stack gap="none">
                      <s-text emphasis="bold">{selectedMainProduct.title}</s-text>
                      <s-text color="subdued" size="small">
                        Produto selecionado
                      </s-text>
                    </s-stack>
                    <s-stack direction="inline" gap="tight">
                      <s-button onClick={handleAddRelation}>
                        Confirmar
                      </s-button>
                      <s-button variant="secondary" onClick={() => setSelectedMainProduct(null)}>
                        Cancelar
                      </s-button>
                    </s-stack>
                  </s-grid>
                </s-box>
              )}
            </s-stack>
          </s-stack>

          {mainProducts.length > 0 && (
            <s-stack gap="base">
              <s-heading level={2}>
                Relações Configuradas ({mainProducts.length})
              </s-heading>

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
                    <s-text>Tente outro termo de busca</s-text>
                  </s-stack>
                </s-box>
              ) : (
                <s-stack gap="base">
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
                      >
                        <s-stack gap="base">
                          <s-grid gap="base" columns="auto 1fr auto" alignItems="center">
                            {mainProduct.images?.[0]?.originalSrc && (
                              <img
                                src={mainProduct.images[0].originalSrc}
                                alt={mainProduct.title}
                                style={{
                                  width: "64px",
                                  height: "64px",
                                  objectFit: "cover",
                                  borderRadius: "8px"
                                }}
                              />
                            )}

                            <s-stack gap="none">
                              <s-text emphasis="bold" size="large">
                                {mainProduct.title}
                              </s-text>
                              <s-text color="subdued" size="small">
                                Produto Principal • {relatedProducts.length} relacionado(s)
                              </s-text>
                            </s-stack>

                            <s-button
                              variant="secondary"
                              onClick={() => handleRemoveMainProduct(productId)}
                            >
                              Remover
                            </s-button>
                          </s-grid>

                          <s-divider />

                          <s-stack gap="tight">
                            <s-text emphasis="bold">
                              Produtos que serão sugeridos:
                            </s-text>

                            <s-button
                              onClick={() => handleSelectRelatedProducts(productId)}
                              variant="secondary"
                            >
                              {relatedProducts.length > 0 ? "Alterar Produtos Relacionados" : "+ Adicionar Produtos Relacionados"}
                            </s-button>

                            {relatedProducts.length > 0 && (
                              <s-stack gap="tight">
                                {relatedProducts.map((related) => (
                                  <s-box
                                    key={related.id}
                                    padding="tight"
                                    background="subdued"
                                    borderRadius="base"
                                  >
                                    <s-grid gap="tight" columns="auto 1fr auto" alignItems="center">
                                      {related.images?.[0]?.originalSrc && (
                                        <img
                                          src={related.images[0].originalSrc}
                                          alt={related.title}
                                          style={{
                                            width: "40px",
                                            height: "40px",
                                            objectFit: "cover",
                                            borderRadius: "6px",
                                            border: "1px solid #e1e3e5"
                                          }}
                                        />
                                      )}
                                      <s-stack gap="none">
                                        <s-text size="medium">{related.title}</s-text>
                                        <s-text color="subdued" size="small">
                                          {related.handle}
                                        </s-text>
                                      </s-stack>
                                      <s-button
                                        variant="plain"
                                        onClick={() => handleRemoveRelatedProduct(productId, related.id)}
                                      >
                                        ✕
                                      </s-button>
                                    </s-grid>
                                  </s-box>
                                ))}
                              </s-stack>
                            )}
                          </s-stack>
                        </s-stack>
                      </s-box>
                    );
                  })}
                </s-stack>
              )}
            </s-stack>
          )}

          {mainProducts.length === 0 && (
            <s-box padding="extra-large" background="subdued" borderRadius="base">
              <s-stack gap="base" alignment="center">
                <s-text emphasis="bold" size="large">
                  Nenhuma relação configurada
                </s-text>
                <s-text alignment="center">
                  Clique em &quot;Adicionar Produto Principal&quot; para começar
                </s-text>
              </s-stack>
            </s-box>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Informações">
        <s-stack gap="base">
          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="tight">
              <s-text emphasis="bold">Como Funciona</s-text>
              <s-text size="small">
                Quando um cliente adiciona um produto principal ao carrinho, os produtos relacionados aparecem como sugestão no checkout.
              </s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="tight">
              <s-text emphasis="bold">Exemplo</s-text>
              <s-text size="small">
                Cliente adiciona &quot;Notebook&quot; → Aparece sugestão de &quot;Mouse&quot;, &quot;Teclado&quot;, &quot;Webcam&quot;
              </s-text>
            </s-stack>
          </s-box>

          <s-box padding="base" background="subdued" borderRadius="base">
            <s-stack gap="tight">
              <s-text emphasis="bold">Interface</s-text>
              <s-text size="small">
                Sugestões aparecem colapsadas com botão (+/-). Cliente expande para ver e adicionar.
              </s-text>
            </s-stack>
          </s-box>
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
