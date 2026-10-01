#!/usr/bin/env node
// Creates the lillo categories (collections), header menu and test products on a Shopify store.
// Safe to re-run: anything that already exists (matched by handle) is skipped.
//
// Usage:  node setup/seed.mjs <store>.myshopify.com
// Needs:  shopify store auth --store <store> --scopes write_products,write_online_store_navigation,write_publications

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const store = process.argv[2];
if (!store) {
  console.error("Usage: node setup/seed.mjs <store>.myshopify.com");
  process.exit(1);
}

const catalog = JSON.parse(readFileSync(new URL("./catalog.json", import.meta.url)));
const tmp = mkdtempSync(join(tmpdir(), "lillo-seed-"));

function gql(query, variables = {}) {
  const q = join(tmp, "q.graphql");
  const v = join(tmp, "v.json");
  writeFileSync(q, query);
  writeFileSync(v, JSON.stringify(variables));
  const args = ["store", "execute", "--json", "--store", store, "--query-file", q, "--variable-file", v];
  if (/^\s*mutation/.test(query)) args.push("--allow-mutations");
  const out = execFileSync("shopify", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out.slice(out.indexOf("{")));
}

function check(result, field) {
  const errors = result[field]?.userErrors ?? [];
  if (errors.length) throw new Error(`${field}: ${JSON.stringify(errors)}`);
  return result[field];
}

// --- Online Store sales channel (products/collections must be published to it to be visible) ---
let onlineStore = null;
try {
  const pubs = gql(`query { publications(first: 20) { nodes { id name } } }`);
  onlineStore = pubs.publications.nodes.find((p) => p.name === "Online Store")?.id ?? null;
} catch {
  console.warn("! No read_publications scope: items will be created but not published to the Online Store.");
}

function publish(id) {
  if (!onlineStore) return;
  check(
    gql(
      `mutation($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) { userErrors { field message } }
      }`,
      { id, input: [{ publicationId: onlineStore }] },
    ),
    "publishablePublish",
  );
}

// --- Collections ---
const collectionIds = {};

function ensureCollection({ title, handle }) {
  const found = gql(`query($h: String!) { collectionByIdentifier(identifier: { handle: $h }) { id } }`, { h: handle });
  let id = found.collectionByIdentifier?.id;
  if (id) {
    console.log(`= collection ${handle}`);
  } else {
    const res = gql(
      `mutation($input: CollectionInput!) {
        collectionCreate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: { title, handle } },
    );
    id = check(res, "collectionCreate").collection.id;
    console.log(`+ collection ${handle}`);
  }
  publish(id);
  collectionIds[handle] = id;
}

const parentOf = {};
for (const cat of catalog.categories) {
  ensureCollection(cat);
  for (const child of cat.children) {
    ensureCollection(child);
    parentOf[child.handle] = cat.handle;
  }
}

// --- Products ---
for (const p of catalog.products) {
  const found = gql(`query($h: String!) { productByIdentifier(identifier: { handle: $h }) { id } }`, { h: p.handle });
  let id = found.productByIdentifier?.id;
  if (id) {
    console.log(`= product ${p.handle}`);
  } else {
    const res = gql(
      `mutation($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product { id variants(first: 1) { nodes { id } } }
          userErrors { field message }
        }
      }`,
      {
        product: {
          title: p.title,
          handle: p.handle,
          descriptionHtml: `<p>${p.description}</p>`,
          status: "ACTIVE",
          tags: ["test"],
          collectionsToJoin: [collectionIds[p.category], collectionIds[parentOf[p.category]]],
        },
      },
    );
    const product = check(res, "productCreate").product;
    id = product.id;
    check(
      gql(
        `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { field message } }
        }`,
        {
          productId: id,
          variants: [{ id: product.variants.nodes[0].id, price: p.price, compareAtPrice: p.compareAt ?? null }],
        },
      ),
      "productVariantsBulkUpdate",
    );
    console.log(`+ product ${p.handle}`);
  }
  publish(id);
}

// --- Header menu (main-menu) ---
const menus = gql(`query { menus(first: 20) { nodes { id handle } } }`);
const mainMenu = menus.menus.nodes.find((m) => m.handle === "main-menu");
const item = (handle, title, items = []) => ({ title, type: "COLLECTION", resourceId: collectionIds[handle], items });
check(
  gql(
    `mutation($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, handle: $handle, items: $items) { menu { id } userErrors { field message } }
    }`,
    {
      id: mainMenu.id,
      title: "Main menu",
      handle: "main-menu",
      items: [
        { title: "მთავარი", type: "FRONTPAGE", url: "/", items: [] },
        ...catalog.categories.map((c) => item(c.handle, c.title, c.children.map((ch) => item(ch.handle, ch.title)))),
      ],
    },
  ),
  "menuUpdate",
);
console.log("+ main-menu updated");
console.log("Done.");
