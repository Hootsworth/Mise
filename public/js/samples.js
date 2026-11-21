export const SAMPLE_RECIPES = [
  {
    id: "sample-miso-rigatoni",
    title: "Brown Butter Miso Mushroom Rigatoni",
    tagline: "Nutty browned butter and white miso emulsify with pasta water into a glossy, deeply savory weeknight glaze.",
    prep_minutes: 8,
    cook_minutes: 14,
    time_minutes: 22,
    difficulty: "Easy",
    servings: 2,
    cuisine: "Japanese-Italian",
    imageUrl: "./images/miso-rigatoni.jpg",
    imageCredit: "Mise Studio",
    visual_prompt: "Glossy rigatoni tossed with seared wild mushrooms, browned butter sheen, cracked black pepper, and chives in a matte ceramic bowl.",
    ingredients: [
      { item: "rigatoni", amount: 220, unit: "g", note: "bronze-die preferred" },
      { item: "mixed mushrooms", amount: 280, unit: "g", note: "torn into bite-sized pieces" },
      { item: "unsalted butter", amount: 45, unit: "g", note: "cubed" },
      { item: "white miso paste", amount: 1.5, unit: "tbsp", note: "room temperature" },
      { item: "garlic cloves", amount: 3, unit: "", note: "thinly sliced" },
      { item: "Parmigiano-Reggiano", amount: 40, unit: "g", note: "finely grated" },
      { item: "lemon juice", amount: 1, unit: "tsp", note: "freshly squeezed" },
      { item: "black pepper", amount: 1, unit: "tsp", note: "coarsely cracked" },
      { item: "chives", amount: 2, unit: "tbsp", note: "finely snipped" }
    ],
    steps: [
      {
        title: "Boil salted water",
        text: "Bring a medium pot of water to a lively simmer, season lightly with salt since miso and cheese bring salinity, and drop the rigatoni. Cook until 2 minutes shy of al dente, about 9 minutes, reserving 180 ml starchy cooking water.",
        minutes: 9
      },
      {
        title: "Sear the mushrooms",
        text: "Set a wide stainless or cast-iron skillet over medium-high heat until hot. Add mushrooms to the dry pan in a single layer and cook undisturbed for 4 minutes until deeply browned on the first side, then toss for 2 minutes more.",
        minutes: 6
      },
      {
        title: "Brown butter & garlic",
        text: "Reduce heat to medium, add the butter and sliced garlic, and swirl as the butter foams, smells toasted and nutty, and turns amber specks at the bottom, about 2 minutes.",
        minutes: 2
      },
      {
        title: "Emulsify the miso",
        text: "Whisk the white miso with 90 ml warm pasta water in a small cup until smooth. Off the heat, pour into the skillet with the drained rigatoni, Parmigiano, and cracked pepper, tossing briskly until glossy.",
        minutes: 2
      },
      {
        title: "Brighten and plate",
        text: "Finish with lemon juice and extra pasta water a splash at a time if tight. Divide into warm bowls and scatter chives over the top.",
        minutes: null
      }
    ],
    tips: [
      "Always whisk miso off the heat — boiling dulls its floral aromatics and splits the emulsion.",
      "Dry-searing mushrooms first drives off water so they caramelize instead of steaming."
    ],
    enrichment: {
      nutrition: {
        per_serving: { calories: 640, protein_g: 22, carbs_g: 82, fat_g: 25, fiber_g: 5, sodium_mg: 780 },
        dietary_tags: ["Vegetarian", "High Umami"],
        note: "Estimated per serving; sodium varies significantly by miso brand and pasta water salinity."
      },
      flavor: {
        axes: { salt: 7, acid: 4, fat: 7, heat: 3, sweet: 2, umami: 10 },
        summary: "Deep roasted umami and nutty browned milk solids balanced by bright lemon and sharp black pepper.",
        finish_adjustments: [
          "Want deeper contrast? Add ¼ tsp grated lemon zest with the chives.",
          "Needs more body? Fold in an extra tablespoon of Parmigiano off-heat."
        ]
      },
      pairings: {
        wine: { name: "Unoaked Chardonnay or Dry Riesling", why: "Crisp orchard acidity cuts through browned butter while echoing miso's fermented complexity." },
        zero_proof: { name: "Cold-Brewed Roasted Barley Tea with Lemon Peel", why: "Toasted grain notes mirror the brown butter cleanly with zero bitterness." },
        side: { name: "Bitter Greens with Sherry Vinaigrette", why: "Radicchio or arugula resets the palate between rich bites." },
        plating: "Serve immediately in warmed low bowls with a final turn of black pepper at the table."
      },
      storage: {
        make_ahead: "Tear mushrooms and grate Parmigiano up to 2 days ahead.",
        fridge: "Keeps in an airtight container for up to 3 days.",
        freezer: "Not recommended — dairy and miso emulsions separate upon thawing.",
        reheat: "Warm gently in a skillet over low heat with 2 tbsp water, stirring constantly until glossy."
      }
    }
  },
  {
    id: "sample-sesame-skillet",
    title: "Crisp-Edged Black Sesame Skillet Cookie",
    tagline: "Toasted tahini-dark dough baked in cast iron with shattering edges, molten chocolate pools, and flaky salt.",
    prep_minutes: 12,
    cook_minutes: 18,
    time_minutes: 30,
    difficulty: "Easy",
    servings: 6,
    cuisine: "Modern Pastry",
    imageUrl: "./images/sesame-skillet.jpg",
    imageCredit: "Mise Studio",
    visual_prompt: "Crisp-edged black sesame skillet cookie in cast iron dotted with melted dark chocolate pools and flaky sea salt.",
    ingredients: [
      { item: "unsalted butter", amount: 115, unit: "g", note: "softened or browned & cooled" },
      { item: "black sesame paste", amount: 65, unit: "g", note: "well stirred" },
      { item: "dark brown sugar", amount: 130, unit: "g", note: "packed" },
      { item: "granulated sugar", amount: 50, unit: "g", note: "" },
      { item: "egg", amount: 1, unit: "", note: "room temperature" },
      { item: "vanilla extract", amount: 1.5, unit: "tsp", note: "" },
      { item: "all-purpose flour", amount: 175, unit: "g", note: "" },
      { item: "baking soda", amount: 0.5, unit: "tsp", note: "" },
      { item: "dark chocolate", amount: 140, unit: "g", note: "70%, roughly chopped" },
      { item: "flaky sea salt", amount: 0.75, unit: "tsp", note: "plus extra for finishing" }
    ],
    steps: [
      {
        title: "Heat the oven",
        text: "Position a rack in the center of the oven and preheat to 180°C. Lightly butter a 20 cm cast-iron skillet.",
        minutes: null
      },
      {
        title: "Whisk fats and sugars",
        text: "Beat butter, black sesame paste, brown sugar, and granulated sugar together for 2 minutes until smooth and glossy. Whisk in the egg and vanilla until ribbon-thick.",
        minutes: 3
      },
      {
        title: "Fold dry & chocolate",
        text: "Stir in flour, baking soda, and flaky sea salt just until no dry flour streaks remain, then fold in three-quarters of the chopped dark chocolate.",
        minutes: 2
      },
      {
        title: "Bake until set edges",
        text: "Press dough evenly into the skillet, dot top with remaining chocolate shards, and bake 16–18 minutes until the perimeter is golden-crisp and the center still looks slightly soft.",
        minutes: 18
      },
      {
        title: "Rest before scooping",
        text: "Scatter flaky salt over the hot surface and rest 8 minutes so the center settles into a fudgy chew.",
        minutes: 8
      }
    ],
    tips: [
      "Pull the skillet while the center still looks underdone — residual cast-iron heat finishes the bake.",
      "Unsweetened pure black sesame paste gives cleaner roast notes than sweetened spreads."
    ],
    enrichment: {
      nutrition: {
        per_serving: { calories: 470, protein_g: 7, carbs_g: 49, fat_g: 28, fiber_g: 3, sodium_mg: 310 },
        dietary_tags: ["Vegetarian", "Nut-Free"],
        note: "Based on 6 generous skillet wedges using 70% dark chocolate."
      },
      flavor: {
        axes: { salt: 5, acid: 1, fat: 8, heat: 0, sweet: 7, umami: 5 },
        summary: "Toasted, earthy black sesame tempers brown sugar caramelization and bitter dark chocolate.",
        finish_adjustments: [
          "Top warm wedges with unsweetened crème fraîche or vanilla bean ice cream.",
          "Add ¼ tsp freshly grated orange zest to lift the roasted sesame."
        ]
      },
      pairings: {
        wine: { name: "Tawny Port or Pedro Ximénez", why: "Nutty oxidized fig notes echo the roasted sesame and dark cacao." },
        zero_proof: { name: "Iced Hojicha Latte or Espresso", why: "Roasted tea leaves or bitter espresso cut cleanly through the molten center." },
        side: { name: "Cold Vanilla Bean Ice Cream", why: "Hot skillet edges meet cold cream for classic temperature contrast." },
        plating: "Bring the cast-iron skillet directly to the table with large spoons."
      },
      storage: {
        make_ahead: "Press dough into the skillet, cover tightly, and refrigerate up to 48 hours before baking.",
        fridge: "Leftover wedges keep 5 days covered.",
        freezer: "Freeze baked wedges individually wrapped up to 2 months.",
        reheat: "Crisp in a 165°C oven for 6 minutes so the edges shatter again."
      }
    }
  },
  {
    id: "sample-charred-cabbage",
    title: "Charred Cabbage & Crispy Chickpeas with Tahini",
    tagline: "Blistered, sweet-centered cabbage wedges over snappy spiced chickpeas and lemony whipped tahini.",
    prep_minutes: 10,
    cook_minutes: 20,
    time_minutes: 30,
    difficulty: "Easy",
    servings: 2,
    cuisine: "Mediterranean",
    imageUrl: "./images/charred-cabbage.jpg",
    imageCredit: "Mise Studio",
    visual_prompt: "Blistered charred cabbage wedges with crispy chickpeas, herbs, and creamy tahini drizzle on stoneware.",
    ingredients: [
      { item: "green cabbage", amount: 500, unit: "g", note: "cut through the core into 4 wedges" },
      { item: "cooked chickpeas", amount: 240, unit: "g", note: "drained and patted dry" },
      { item: "olive oil", amount: 3, unit: "tbsp", note: "divided" },
      { item: "ground cumin", amount: 1, unit: "tsp", note: "" },
      { item: "tahini", amount: 3, unit: "tbsp", note: "well stirred" },
      { item: "lemon juice", amount: 2, unit: "tbsp", note: "freshly squeezed" },
      { item: "garlic clove", amount: 1, unit: "", note: "finely grated" },
      { item: "fresh dill or parsley", amount: 2, unit: "tbsp", note: "chopped" },
      { item: "flaky sea salt", amount: 1, unit: "tsp", note: "to taste" }
    ],
    steps: [
      {
        title: "Blister cabbage wedges",
        text: "Heat 2 tbsp olive oil in a heavy skillet over medium-high heat. Lay cabbage wedges flat, season with salt, and sear undisturbed 5 minutes per cut side until deeply charred and edges crisp, then transfer to a platter.",
        minutes: 10
      },
      {
        title: "Crisp the chickpeas",
        text: "Add remaining 1 tbsp oil to the same pan, tumble in the dried chickpeas and cumin, and fry over medium-high heat 6 minutes, shaking occasionally until blistered and crunchy.",
        minutes: 6
      },
      {
        title: "Whip lemon tahini",
        text: "Whisk tahini, lemon juice, grated garlic, and a pinch of salt with 2–3 tbsp cold water a splash at a time until pale, smooth, and pourable.",
        minutes: 2
      },
      {
        title: "Assemble and drizzle",
        text: "Spoon the crispy chickpeas over the warm charred cabbage, ribbon generously with whipped tahini, and scatter chopped herbs on top.",
        minutes: null
      }
    ],
    tips: [
      "Keep the cabbage core intact on each wedge so leaves hold together cleanly while searing.",
      "Patted-dry chickpeas crisp rapidly without splattering oil."
    ]
  },
  {
    id: "sample-crispy-rice-bowl",
    title: "Pan-Crisped Rice Bowl with Glazed Tofu & Jammy Egg",
    tagline: "Crackling pan-fried rice crowned with lacquered tofu, charred mushrooms, scallions, and a soft-set yolk.",
    prep_minutes: 10,
    cook_minutes: 15,
    time_minutes: 25,
    difficulty: "Easy",
    servings: 2,
    cuisine: "Pan-Asian",
    imageUrl: "./images/crispy-rice-bowl.jpg",
    imageCredit: "Mise Studio",
    visual_prompt: "Pan-crisped rice bowl topped with glazed tofu, seared mushrooms, a jammy halved egg, sesame seeds, and scallions.",
    ingredients: [
      { item: "day-old cooked rice", amount: 340, unit: "g", note: "broken up" },
      { item: "firm tofu", amount: 200, unit: "g", note: "pressed and cubed" },
      { item: "shiitake mushrooms", amount: 150, unit: "g", note: "sliced" },
      { item: "eggs", amount: 2, unit: "", note: "cold from fridge" },
      { item: "soy sauce", amount: 2, unit: "tbsp", note: "" },
      { item: "toasted sesame oil", amount: 2, unit: "tsp", note: "" },
      { item: "honey or maple syrup", amount: 1, unit: "tsp", note: "" },
      { item: "scallions", amount: 3, unit: "", note: "thinly sliced" },
      { item: "toasted sesame seeds", amount: 1, unit: "tbsp", note: "" }
    ],
    steps: [
      {
        title: "Simmer jammy eggs",
        text: "Lower cold eggs gently into boiling water and simmer 6 minutes 30 seconds. Transfer straight to an ice bath for 3 minutes, peel, and halve.",
        minutes: 7
      },
      {
        title: "Sear tofu & mushrooms",
        text: "Sear cubed tofu and sliced mushrooms in a lightly oiled skillet over medium-high heat 5 minutes until browned. Toss with soy sauce, sesame oil, and honey until glossy, then set aside.",
        minutes: 5
      },
      {
        title: "Crisp the rice",
        text: "Press day-old rice into an even layer in the hot skillet with a drop of oil and leave untouched 4 minutes until a golden, crackling crust forms underneath.",
        minutes: 4
      },
      {
        title: "Build the bowls",
        text: "Scoop crispy rice into warm bowls, arrange glazed tofu, mushrooms, and halved jammy eggs on top, and finish with scallions and sesame seeds.",
        minutes: null
      }
    ],
    tips: [
      "Day-old refrigerated rice has drier surface starch so it crisps instead of clumping.",
      "Resist stirring the rice while it builds its golden crust."
    ]
  }
];

export const SAMPLE_IDEAS = {
  prompt_summary: "4 test-kitchen dishes featuring miso, mushrooms, pantry staples & cast iron",
  options: [
    {
      id: "sample-miso-rigatoni",
      title: "Brown Butter Miso Mushroom Rigatoni",
      tagline: "Nutty browned butter and white miso emulsify with pasta water into a glossy weeknight glaze.",
      time_minutes: 22,
      difficulty: "Easy",
      cuisine: "Japanese-Italian",
      vibe: "Glossy & Umami",
      uses: ["mushrooms", "white miso", "butter"],
      extras_needed: ["rigatoni", "Parmigiano"],
      pantry_only: false,
      imageUrl: "./images/miso-rigatoni.jpg",
      imageCredit: "Mise Studio",
      visual_prompt: "Glossy rigatoni tossed with seared wild mushrooms and chives in a matte ceramic bowl.",
      sampleRecipeId: "sample-miso-rigatoni"
    },
    {
      id: "sample-crispy-rice-bowl",
      title: "Pan-Crisped Rice Bowl with Glazed Tofu & Jammy Egg",
      tagline: "Crackling skillet rice topped with lacquered tofu, mushrooms, scallions, and a soft-set yolk.",
      time_minutes: 25,
      difficulty: "Easy",
      cuisine: "Pan-Asian",
      vibe: "Crisp & Hearty",
      uses: ["rice", "mushrooms", "eggs"],
      extras_needed: ["firm tofu", "soy sauce"],
      pantry_only: false,
      imageUrl: "./images/crispy-rice-bowl.jpg",
      imageCredit: "Mise Studio",
      visual_prompt: "Pan-crisped rice bowl topped with glazed tofu, mushrooms, jammy egg, and scallions.",
      sampleRecipeId: "sample-crispy-rice-bowl"
    },
    {
      id: "sample-charred-cabbage",
      title: "Charred Cabbage & Crispy Chickpeas with Tahini",
      tagline: "Blistered sweet-centered cabbage wedges over crunchy cumin chickpeas and lemon tahini.",
      time_minutes: 30,
      difficulty: "Easy",
      cuisine: "Mediterranean",
      vibe: "Charred & Bright",
      uses: ["cabbage", "chickpeas", "tahini"],
      extras_needed: [],
      pantry_only: true,
      imageUrl: "./images/charred-cabbage.jpg",
      imageCredit: "Mise Studio",
      visual_prompt: "Blistered charred cabbage wedges with crispy chickpeas and creamy tahini drizzle on stoneware.",
      sampleRecipeId: "sample-charred-cabbage"
    },
    {
      id: "sample-sesame-skillet",
      title: "Crisp-Edged Black Sesame Skillet Cookie",
      tagline: "Toasted sesame dough baked in cast iron with shattering edges and molten dark chocolate.",
      time_minutes: 30,
      difficulty: "Easy",
      cuisine: "Modern Pastry",
      vibe: "Toasted & Molten",
      uses: ["butter", "chocolate", "egg"],
      extras_needed: ["black sesame paste"],
      pantry_only: false,
      imageUrl: "./images/sesame-skillet.jpg",
      imageCredit: "Mise Studio",
      visual_prompt: "Crisp-edged black sesame skillet cookie in cast iron with melted chocolate and flaky salt.",
      sampleRecipeId: "sample-sesame-skillet"
    }
  ]
};
