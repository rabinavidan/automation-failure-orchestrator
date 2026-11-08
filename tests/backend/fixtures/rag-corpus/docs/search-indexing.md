# Search index freshness

Product search reads from an index that refreshes every five seconds. Writes reach the index
asynchronously, so a test that searches immediately after creating a product can see zero
results. Tests should poll the search endpoint until the refreshed index contains the product.
