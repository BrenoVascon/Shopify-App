import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState, useCallback } from "preact/hooks";
import {
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
      const cartLines = lines.value;
      const cartProductIds = cartLines
        .map((line) => line.merchandise.product?.id)
        .filter(Boolean);

      if (cartProductIds.length === 0) {
        setProducts([]);
        setLoading(false);
        return;
      }

      const cartLineProductVariantIds = cartLines.map((item) => item.merchandise.id);
      const excludedIds = new Set(cartProductIds);
      const globalSeenProductIds = new Set();
      const newCartLineRecommendations = new Map();

      const isProductValid = (product, seenIds) => {
        if (!product || !product.id) return false;
        if (excludedIds.has(product.id)) return false;
        if (seenIds.has(product.id)) return false;
        const firstVariant = getFirstAvailableVariant(product);
        if (!firstVariant) return false;
        if (cartLineProductVariantIds.includes(firstVariant.id)) return false;
        return true;
      };

      const findFirstValidRec = (recs, seenIds) => {
        for (const rec of recs) {
          if (isProductValid(rec, seenIds)) {
            return rec;
          }
        }
        return null;
      };

      for (let i = 0; i < cartLines.length; i++) {
        const line = cartLines[i];
        const productId = line.merchandise.product?.id;
        if (!productId) continue;

        let pickedRec = null;

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

        const rawData = raw?.data || {};
        const recs = Array.isArray(rawData['productRecommendations'])
          ? rawData['productRecommendations']
          : [];

        const validRec = findFirstValidRec(recs, globalSeenProductIds);
        if (validRec) {
          pickedRec = validRec;
          globalSeenProductIds.add(validRec.id);
        }

        if (!pickedRec) {
          const rawMeta = await query(
            `query ($id: ID!) {
               node(id: $id) {
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
            { variables: { id: productId } }
          );

          // @ts-ignore
          const node = rawMeta?.data?.node;
          const meta = node?.metafield || null;
          const refs =
            meta &&
            meta.references &&
            Array.isArray(meta.references.nodes)
              ? meta.references.nodes
              : [];

          if (refs.length > 0) {
            const validRef = findFirstValidRec(refs, globalSeenProductIds);
            if (validRef) {
              pickedRec = validRef;
              globalSeenProductIds.add(validRef.id);
            }
          } else if (meta && meta.value) {
            try {
              const parsed = JSON.parse(meta.value);
              if (Array.isArray(parsed) && parsed.length > 0) {
                for (const gid of parsed) {
                  if (typeof gid === "string" && !excludedIds.has(gid) && !globalSeenProductIds.has(gid)) {
                    const rawDetails = await query(
                      `query ($id: ID!) {
                         node(id: $id) {
                           ... on Product {
                             id
                             title
                             images(first:1) { nodes { url } }
                             variants(first:3) { nodes { id availableForSale price { amount currencyCode } } }
                           }
                         }
                       }`,
                      { variables: { id: gid } }
                    );
                    // @ts-ignore
                    const detailNode = rawDetails?.data?.node;
                    if (detailNode && isProductValid(detailNode, globalSeenProductIds)) {
                      pickedRec = detailNode;
                      globalSeenProductIds.add(detailNode.id);
                      break;
                    }
                  }
                }
              }
            } catch (err) {
              console.warn("metafield value não é JSON válido:", meta.value);
            }
          }
        }

        if (pickedRec) {
          newCartLineRecommendations.set(line.id, pickedRec);
        }
      }

      const uniqueRecommendations = Array.from(newCartLineRecommendations.values());
      const uniqueProducts = [];
      const seenIds = new Set();
      for (const rec of uniqueRecommendations) {
        if (rec && rec.id && !seenIds.has(rec.id)) {
          seenIds.add(rec.id);
          uniqueProducts.push(rec);
        }
      }

      setProducts(uniqueProducts);
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
          {/* @ts-ignore */}
          <Icon source={expanded ? 'chevronUp' : 'chevronDown'} />
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
