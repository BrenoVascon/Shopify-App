import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState, useCallback } from "preact/hooks";
import {
  reactExtension,
  Icon,
} from '@shopify/ui-extensions-react/checkout';


export default function () {
  render(<Extension />, document.body);
}

function Extension() {
  const { applyCartLinesChange, query, i18n } = shopify;
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showError, setShowError] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { lines } = shopify;

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const cartProductIds = lines.value
        .map((line) => line.merchandise.product?.id)
        .filter(Boolean);

      if (cartProductIds.length === 0) {
        setProducts([]);
        setLoading(false);
        return;
      }

      const perProductRecs = [];

      await Promise.all(
        cartProductIds.map(async (productId) => {
          const raw = await query(
            `query RelatedProducts($productId: ID!) {
               productRecommendations(productId: $productId, intent: RELATED) {
                 id
                 title
                 images(first: 1) { nodes { url } }
                 variants(first: 3) { nodes { id availableForSale price { amount currencyCode } } }
               }
             }`,
            { variables: { productId } }
          );

          const recs =
            raw &&
            raw.data &&
            Array.isArray(raw.data.productRecommendations)
              ? raw.data.productRecommendations
              : [];

          const availableRecs = recs.filter((rec) => getFirstAvailableVariant(rec));
          perProductRecs.push(availableRecs);
        })
      );

      const chosenIds = new Set();
      let relatedList = [];

      perProductRecs.forEach((list) => {
        const unique = list.find(
          (rec) => rec && rec.id && getFirstAvailableVariant(rec) && !chosenIds.has(rec.id)
        );
        const pick = unique || list.find((rec) => rec && rec.id && getFirstAvailableVariant(rec));
        if (pick) {
          relatedList.push(pick);
          chosenIds.add(pick.id);
        }
      });

      if (relatedList.length < cartProductIds.length) {
        const extraPool = perProductRecs.flat().filter((rec) => rec && rec.id && getFirstAvailableVariant(rec));
        for (const rec of extraPool) {
          if (relatedList.length >= cartProductIds.length) break;
          if (chosenIds.has(rec.id)) continue;
          relatedList.push(rec);
          chosenIds.add(rec.id);
        }
      }

      if (relatedList.length < cartProductIds.length) {
        const rawMeta = await query(
          `query ($ids: [ID!]!) {
             nodes(ids: $ids) {
               ... on Product {
                 id
                 title
                 metafield(namespace: "custom", key: "related_products") {
                   type
                   value
                   references(first: 5) {
                     nodes {
                       ... on Product {
                         id
                         title
                        images(first:1) { nodes { url } }
                        variants(first:3) { nodes { id availableForSale price { amount currencyCode } } }
                       }
                     }
                   }
                 }
               }
             }
           }`,
          { variables: { ids: cartProductIds } }
        );

        const metaNodes =
          rawMeta &&
          rawMeta.data &&
          Array.isArray(rawMeta.data.nodes)
            ? rawMeta.data.nodes
            : [];

        const metaMap = new Map();

        // Coleta de references
        metaNodes.forEach((node) => {
          const meta = node?.metafield || null;
          const refs =
            meta &&
            meta.references &&
            Array.isArray(meta.references.nodes)
              ? meta.references.nodes
              : [];

          refs.forEach((ref) => {
            if (ref && ref.id && !metaMap.has(ref.id)) {
              metaMap.set(ref.id, ref);
            }
          });
        });

        let metaRelatedList = Array.from(metaMap.values());

        // Se só IDs, busca detalhes pelo value (JSON) ou pelas refs vazias
        const onlyIds =
          relatedList.length > 0 &&
          relatedList.every(
            (r) => r && typeof r === "object" && Object.keys(r).length === 1 && "id" in r
          );

        if (!metaRelatedList.length) {
          // refs vazias: tenta ler value JSON para pegar GIDs
          const idsFromValue = new Set();
          metaNodes.forEach((node) => {
            const meta = node?.metafield || null;
            if (meta && meta.value) {
              try {
                const parsed = JSON.parse(meta.value);
                if (Array.isArray(parsed)) {
                  parsed.forEach((g) => typeof g === "string" && idsFromValue.add(g));
                }
              } catch (err) {
                console.warn("metafield value não é JSON ou não é lista de GIDs:", meta.value);
              }
            }
          });

          const idsArr = Array.from(idsFromValue);
          if (idsArr.length > 0) {
            const rawDetails = await query(
              `query ($ids: [ID!]!) {
                 nodes(ids: $ids) {
                   ... on Product {
                     id
                     title
                   images(first:1) { nodes { url } }
                   variants(first:3) { nodes { id availableForSale price { amount currencyCode } } }
                   }
                 }
               }`,
              { variables: { ids: idsArr } }
            );
            metaRelatedList =
              rawDetails &&
              rawDetails.data &&
              Array.isArray(rawDetails.data.nodes)
                ? rawDetails.data.nodes.filter(Boolean)
                : [];
          }
        } else if (onlyIds) {
          const ids = relatedList.map((r) => r.id);
          const rawDetails = await query(
            `query ($ids: [ID!]!) {
               nodes(ids: $ids) {
                 ... on Product {
                   id
                   title
                   images(first:1) { nodes { url } }
                   variants(first:3) { nodes { id availableForSale price { amount currencyCode } } }
                 }
               }
             }`,
            { variables: { ids } }
          );
          metaRelatedList =
            rawDetails &&
            rawDetails.data &&
            Array.isArray(rawDetails.data.nodes)
              ? rawDetails.data.nodes.filter(Boolean)
              : [];
        }

        for (const rec of metaRelatedList) {
          if (relatedList.length >= cartProductIds.length) break;
          if (!rec || !rec.id || chosenIds.has(rec.id)) continue;
          if (!getFirstAvailableVariant(rec)) continue;
          relatedList.push(rec);
          chosenIds.add(rec.id);
        }
      }

      if (!relatedList.length) {
        relatedList = perProductRecs
          .flat()
          .filter((rec) => rec && rec.id && getFirstAvailableVariant(rec) && !chosenIds.has(rec.id));
      }

      setProducts(relatedList || []);
    } catch (error) {
      console.error("Error fetching products:", error);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [query, lines.value]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  useEffect(() => {
    if (showError) {
      const timer = setTimeout(() => setShowError(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [showError]);

  async function handleAddToCart(variantId) {
    setAdding(true);
    const result = await applyCartLinesChange({
      type: "addCartLine",
      merchandiseId: variantId,
      quantity: 1,
    });
    setAdding(false);
    if (result.type === "error") {
      setShowError(true);
      console.error(result.message);
    }
  }

  if (loading) {
    return <LoadingSkeleton />;
  }

  const productsOnOffer = getProductsOnOffer(lines.value, products);

  // Limita 1 sugestão por line item base:
  // - mainLinesCount: itens do carrinho que não são sugestões (fora da lista recomendada)
  // - suggestionsInCart: quantos produtos recomendados já estão no carrinho
  const recommendedIds = new Set(products.map((p) => p.id));
  const mainLinesCount = lines.value.filter(
    (line) => !recommendedIds.has(line.merchandise.product?.id)
  ).length;
  const suggestionsInCart = lines.value.filter((line) =>
    recommendedIds.has(line.merchandise.product?.id)
  ).length;
  const suggestionLimitReached = suggestionsInCart >= mainLinesCount && mainLinesCount > 0;

  if (!productsOnOffer.length) {
    return (
      <s-banner tone="info">
        <s-stack gap="base">
          <s-text>Nenhuma sugestão disponível para este carrinho.</s-text>
          <s-button variant="secondary" onClick={fetchProducts}>
            Atualizar sugestões
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  return (
    <ProductOffer
      products={productsOnOffer}
      i18n={i18n}
      adding={adding}
      handleAddToCart={handleAddToCart}
      showError={showError}
      expanded={expanded}
      setExpanded={setExpanded}
      suggestionLimitReached={suggestionLimitReached}
    />
  );
}

function LoadingSkeleton() {
  return (
    <s-stack gap="large-200">
      <s-divider />
      <s-heading>You might also like</s-heading>
      <s-stack gap="base">
        <s-grid
          gap="base"
          gridTemplateColumns="64px 1fr auto"
          alignItems="center"
        >
          <s-image loading="lazy" />
          <s-stack gap="none">
            <s-skeleton-paragraph />
            <s-skeleton-paragraph />
          </s-stack>
          <s-button variant="secondary" disabled={true}>
            Add
          </s-button>
        </s-grid>
      </s-stack>
    </s-stack>
  );
}

function getProductsOnOffer(lines, products) {
  const cartLineProductVariantIds = lines.map((item) => item.merchandise.id);
  return products.filter((product) => {
    const firstAvailable = getFirstAvailableVariant(product);
    if (!firstAvailable) return false;
    const inCart = cartLineProductVariantIds.includes(firstAvailable.id);
    return !inCart;
  });
}

function getFirstAvailableVariant(product) {
  const variantsNodes = product?.variants?.nodes || [];
  return variantsNodes.find((v) => v && v.availableForSale) || null;
}

/* eslint-disable react/prop-types */
function ProductOffer({ products, i18n, adding, handleAddToCart, showError, expanded, setExpanded, suggestionLimitReached }) {
  return (
    <s-stack gap="large-200">
      <s-grid gap="base" gridTemplateColumns="1fr auto" alignItems="center">
        <s-heading>You might also like</s-heading>
        <s-button
          onClick={() => setExpanded(!expanded)}
        >
          <Icon source={expanded ? 'chevron-up' : 'chevron-down'} />
        </s-button>
      </s-grid>

      {expanded && (
        <s-stack gap="base">
          {products.map((product, index) => {
            const { images = { nodes: [] }, title, variants = { nodes: [] } } = product;
            const priceAmount = variants.nodes[0] && variants.nodes[0].price ? variants.nodes[0].price.amount : null;
            const renderPrice = priceAmount ? i18n.formatCurrency(priceAmount) : "";
            const imageUrl =
              images.nodes[0]?.url ??
              "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_medium.png?format=webp&v=1530129081";

            return (
              <s-grid
                key={`${product.id}-${index}`}
                gap="base"
                gridTemplateColumns="64px 1fr auto"
                alignItems="center"
              >
                <s-image
                  borderWidth="base"
                  borderRadius="large-100"
                  src={imageUrl}
                  alt={title}
                  aspectRatio="1"
                />
                <s-stack gap="none">
                  <s-text type="strong">{title}</s-text>
                  <s-text color="subdued">{renderPrice}</s-text>
                </s-stack>
                <s-button
                  variant="secondary"
                  loading={adding}
                  disabled={suggestionLimitReached}
                  accessibilityLabel={`Add ${title} to cart`}
                  onClick={() => handleAddToCart(variants.nodes[0]?.id)}
                >
                  {suggestionLimitReached ? "Limit reached" : "Add"}
                </s-button>
              </s-grid>
            );
          })}
        </s-stack>
      )}
      {showError && <ErrorBanner />}
    </s-stack>
  );
}
/* eslint-enable react/prop-types */

function ErrorBanner() {
  return (
    <s-banner tone="critical">
      There was an issue adding this product. Please try again.
    </s-banner>
  );
}
