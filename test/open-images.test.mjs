import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSearchQueries,
  fetchOpenversePhoto,
  fetchWikimediaCommonsPhoto,
  fetchMealDbPhoto,
  fetchWikipediaPhoto,
  fetchOpenDishPhoto
} from "../public/js/open-images.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

test("buildSearchQueries strips filler adjectives and appends core/cuisine variants", () => {
  const queries = buildSearchQueries("Crispy Pan-Seared Salmon & Charred Leeks", "Nordic");
  assert.deepEqual(queries, [
    "Crispy Pan-Seared Salmon Charred Leeks",
    "Pan-Seared Salmon Leeks",
    "Salmon Leeks",
    "Pan-Seared Salmon Leeks Nordic"
  ]);

  assert.deepEqual(buildSearchQueries("", "Italian"), []);
});

test("fetchOpenversePhoto filters small/excluded images and returns creator credit", async () => {
  const exclude = new Set(["https://cdn.openverse.org/excluded.jpg"]);
  const mockFetch = async (url, init) => {
    assert.match(url, /^https:\/\/api\.openverse\.org\/v1\/images\//);
    assert.ok(init.headers["User-Agent"]);
    return jsonResponse({
      results: [
        { thumbnail: "http://insecure.example/1.jpg", width: 800, creator: "Bad" },
        { thumbnail: "https://cdn.openverse.org/tiny.jpg", width: 250, creator: "Tiny" },
        { thumbnail: "https://cdn.openverse.org/excluded.jpg", width: 800, creator: "Skip" },
        {
          thumbnail: "https://cdn.openverse.org/good-dish.jpg",
          width: 1000,
          creator: "Chef Lens",
          foreign_landing_url: "https://example.org/photo/1"
        }
      ]
    });
  };

  const photo = await fetchOpenversePhoto("miso ramen", exclude, mockFetch);
  assert.deepEqual(photo, {
    imageUrl: "https://cdn.openverse.org/good-dish.jpg",
    source: "openverse",
    credit: "Openverse · Chef Lens",
    creditUrl: "https://example.org/photo/1"
  });
});

test("fetchWikimediaCommonsPhoto skips SVGs and small thumbnails", async () => {
  const mockFetch = async (url) => {
    assert.match(url, /^https:\/\/commons\.wikimedia\.org\/w\/api\.php/);
    return jsonResponse({
      query: {
        pages: {
          1: {
            index: 1,
            title: "File:Icon.svg",
            imageinfo: [{ mime: "image/svg+xml", thumbwidth: 960, thumburl: "https://upload.wikimedia.org/icon.svg" }]
          },
          2: {
            index: 2,
            title: "File:Small.jpg",
            imageinfo: [{ mime: "image/jpeg", thumbwidth: 200, thumburl: "https://upload.wikimedia.org/small.jpg" }]
          },
          3: {
            index: 3,
            title: "File:Ramen.jpg",
            imageinfo: [
              {
                mime: "image/jpeg",
                thumbwidth: 960,
                thumburl: "https://upload.wikimedia.org/ramen-960.jpg",
                descriptionurl: "https://commons.wikimedia.org/wiki/File:Ramen.jpg"
              }
            ]
          }
        }
      }
    });
  };

  const photo = await fetchWikimediaCommonsPhoto("ramen", new Set(), mockFetch);
  assert.deepEqual(photo, {
    imageUrl: "https://upload.wikimedia.org/ramen-960.jpg",
    source: "wikimedia",
    credit: "Wikimedia Commons",
    creditUrl: "https://commons.wikimedia.org/wiki/File:Ramen.jpg"
  });
});

test("fetchMealDbPhoto and fetchWikipediaPhoto parse valid dish photos", async () => {
  const mdb = await fetchMealDbPhoto("shakshuka", new Set(), async (url) => {
    assert.match(url, /^https:\/\/www\.themealdb\.com\/api\/json\/v1\/1\/search\.php/);
    return jsonResponse({
      meals: [
        { strMealThumb: "https://www.themealdb.com/images/media/meals/shakshuka.jpg", strSource: "https://example.com/shakshuka" }
      ]
    });
  });
  assert.deepEqual(mdb, {
    imageUrl: "https://www.themealdb.com/images/media/meals/shakshuka.jpg",
    source: "themealdb",
    credit: "TheMealDB",
    creditUrl: "https://example.com/shakshuka"
  });

  const wp = await fetchWikipediaPhoto("shakshuka", new Set(), async (url) => {
    assert.match(url, /^https:\/\/en\.wikipedia\.org\/w\/api\.php/);
    return jsonResponse({
      query: {
        pages: {
          10: { index: 1, thumbnail: { source: "https://example.com/not-wikimedia.jpg" } },
          11: { index: 2, thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/shakshuka.jpg" } }
        }
      }
    });
  });
  assert.deepEqual(wp, {
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/shakshuka.jpg",
    source: "wikipedia",
    credit: "Wikipedia · Wikimedia",
    creditUrl: ""
  });
});

test("fetchOpenDishPhoto cascades Openverse -> Wikimedia -> TheMealDB -> Wikipedia and cycles excludeUrls", async () => {
  const seenHosts = [];
  const exclude = ["https://cdn.openverse.org/1.jpg", "https://upload.wikimedia.org/1.jpg"];
  const mockFetch = async (url) => {
    const host = new URL(url).hostname;
    seenHosts.push(host);
    if (host === "api.openverse.org") {
      return jsonResponse({
        results: [{ thumbnail: "https://cdn.openverse.org/1.jpg", width: 900 }]
      });
    }
    if (host === "commons.wikimedia.org") {
      return jsonResponse({
        query: {
          pages: {
            1: {
              index: 1,
              title: "File:Excluded.jpg",
              imageinfo: [{ mime: "image/jpeg", thumbwidth: 800, thumburl: "https://upload.wikimedia.org/1.jpg" }]
            }
          }
        }
      });
    }
    if (host === "www.themealdb.com") {
      return jsonResponse({ meals: null });
    }
    if (host === "en.wikipedia.org") {
      return jsonResponse({
        query: {
          pages: {
            5: { index: 0, thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/paella.jpg" } }
          }
        }
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  const photo = await fetchOpenDishPhoto({
    title: "Crispy Valencian Paella",
    cuisine: "Spanish",
    excludeUrls: exclude,
    fetchImpl: mockFetch
  });

  assert.deepEqual(seenHosts, [
    "api.openverse.org",
    "commons.wikimedia.org",
    "www.themealdb.com",
    "en.wikipedia.org"
  ]);
  assert.deepEqual(photo, {
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/paella.jpg",
    source: "wikipedia",
    credit: "Wikipedia · Wikimedia",
    creditUrl: ""
  });

  const empty = await fetchOpenDishPhoto({ title: "", fetchImpl: mockFetch });
  assert.deepEqual(empty, { imageUrl: null, source: "none", credit: "", creditUrl: "" });
});
