-- CreateTable
CREATE TABLE "ProductSuggestionConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "selectedProducts" TEXT NOT NULL,
    "productRelations" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductSuggestionConfig_shop_key" ON "ProductSuggestionConfig"("shop");
