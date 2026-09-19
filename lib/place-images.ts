// Stock photos via picsum.photos (curated Unsplash content, seed = consistent image per place).
// Descriptions are short editorial blurbs shown in the map tooltip.

type PlaceInfo = { seed: string; description: string };

const PLACES: Record<string, PlaceInfo> = {
  // Bali
  "bali/denpasar": {
    seed: "bali-denpasar-temple",
    description: "The island's capital — a city of morning rituals, incense-threaded laneways, and temples older than any building you know.",
  },
  "bali/ubud": {
    seed: "ubud-rice-terrace-forest",
    description: "Bali's creative heart, ringed by rice terraces and green gorges. The pace here is different — you'll feel it by the second afternoon.",
  },
  "bali/seminyak": {
    seed: "seminyak-beach-sunset",
    description: "Where the island faces the Indian Ocean at its most golden. Long beaches, unhurried evenings, and some of the best food on the island.",
  },
  "bali/nusa-penida": {
    seed: "nusa-penida-cliff-ocean",
    description: "Dramatic limestone cliffs above turquoise water. Still rough around the edges, which is exactly why it's worth the short crossing.",
  },
  "bali/mount-batur": {
    seed: "mount-batur-volcano-crater",
    description: "An active caldera with a lake inside it. The pre-dawn climb is brutal. The sunrise from the rim is not something you'll describe well to anyone else.",
  },
  // Dubai
  "dubai/dubai": {
    seed: "dubai-skyline-desert",
    description: "A city built in decades rather than centuries — audacious, air-conditioned, and stranger than it looks in photographs.",
  },
  "dubai/abu-dhabi": {
    seed: "abu-dhabi-mosque-architecture",
    description: "The capital holds its cards closer than Dubai. Quieter, more considered — and home to one of the most beautiful mosques on earth.",
  },
  "dubai/hatta": {
    seed: "hatta-mountains-dam-uae",
    description: "An hour from the city, a different UAE emerges: red mountains, a turquoise reservoir, and hiking trails with almost no one on them.",
  },
  "dubai/liwa-oasis": {
    seed: "liwa-desert-dunes-oasis",
    description: "The Empty Quarter begins here. Some of the highest dunes on the planet, an oasis at their feet, and an immense silence overhead.",
  },
  // Kashmir
  "kashmir/srinagar": {
    seed: "srinagar-dal-lake-morning",
    description: "A city on a lake, with houseboats that creak gently at dawn. The markets are layered and fragrant. Arrival here feels like stepping out of time.",
  },
  "kashmir/gulmarg": {
    seed: "gulmarg-snow-meadow",
    description: "A meadow at altitude that becomes a ski run in winter and a flower-filled bowl in summer. The cable car goes higher than most people expect.",
  },
  "kashmir/pahalgam": {
    seed: "pahalgam-river-valley",
    description: "Where a cold river threads through pine forest and the valley widens into something that looks quietly impossible.",
  },
  "kashmir/sonamarg": {
    seed: "sonamarg-glacier-peaks",
    description: "The Meadow of Gold. Glaciers visible from the road. The air is thin and cold even in August, which is part of the point.",
  },
  "kashmir/leh": {
    seed: "leh-ladakh-monastery-peaks",
    description: "A plateau city at 3,500 metres, ringed by prayer flags and bare mountains. Monasteries perched on cliffs you wouldn't dare build on.",
  },
  // Kenya
  "kenya/nairobi": {
    seed: "nairobi-kenya-savanna-skyline",
    description: "The only city in the world with a national park on its edge. Giraffes visible from the business district. A gateway that's worth the stay.",
  },
  "kenya/maasai-mara": {
    seed: "maasai-mara-safari-savanna",
    description: "The great migration passes through here — a river crossing that's been described a thousand times and still stops conversation dead.",
  },
  "kenya/amboseli": {
    seed: "amboseli-elephants-kilimanjaro",
    description: "Elephant herds against a backdrop of Kilimanjaro on a clear morning. One of those views that doesn't need any preparation.",
  },
  "kenya/lake-nakuru": {
    seed: "lake-nakuru-flamingos-pink",
    description: "A soda lake that turns pink with flamingos and holds rhinos on its shore. Compact, accessible, and reliably astonishing.",
  },
  "kenya/diani-beach": {
    seed: "diani-beach-white-sand-ocean",
    description: "White coral sand, warm Indian Ocean, and the kind of quiet that only comes from being far enough south of everywhere else.",
  },
  // Kyoto
  "kyoto/kyoto": {
    seed: "kyoto-temple-autumn-japan",
    description: "Seventeen centuries of refinement concentrated into a walkable city. Every season looks like someone planned it specifically for photography.",
  },
  "kyoto/fushimi-inari": {
    seed: "fushimi-inari-torii-orange",
    description: "Thousands of vermilion gates climbing the forested mountain. Go early or late — the middle of the day belongs to everyone else.",
  },
  "kyoto/arashiyama": {
    seed: "arashiyama-bamboo-forest",
    description: "A bamboo grove that absorbs sound in a way that feels deliberate. The surrounding hills and river are equally worth the time.",
  },
  "kyoto/gion": {
    seed: "gion-kyoto-lanterns-evening",
    description: "Kyoto's old geisha district — wooden townhouses, stone-paved lanes, paper lanterns. The evening light here has its own quality.",
  },
  "kyoto/kinkaku-ji": {
    seed: "kinkakuji-golden-pavilion-reflection",
    description: "A gold-leaf pavilion reflected in still water. Absurdly beautiful, even with crowds. Some things justify the cliché.",
  },
  // Morocco
  "morocco/marrakech": {
    seed: "marrakech-medina-souks-morocco",
    description: "A city that moves on its own logic — labyrinthine, layered, and scented with spice and cedar. The longer you stay, the more it opens.",
  },
  "morocco/fes": {
    seed: "fes-medina-alley-morocco",
    description: "The world's largest car-free urban area. A medieval city still operating as one. The tanneries alone are worth the journey.",
  },
  "morocco/chefchaouen": {
    seed: "chefchaouen-blue-white-walls",
    description: "A mountain town painted in every shade of blue. The streets are steep, the light is exceptional, and the pace is deliberately slow.",
  },
  "morocco/merzouga": {
    seed: "merzouga-sahara-dunes-camel",
    description: "Where the Sahara starts. Dunes that shift with the wind and glow amber at last light — the silence here is a different kind of full.",
  },
  "morocco/essaouira": {
    seed: "essaouira-blue-boats-port",
    description: "A windswept Atlantic port with blue fishing boats, whitewashed ramparts, and a character that resists being tidied up for tourists.",
  },
  // Nordic
  "nordic/oslo": {
    seed: "oslo-norway-fjord-city",
    description: "A capital that starts at the water and climbs into forested hills. Clean, considered, and quieter than you expect for a capital.",
  },
  "nordic/bergen": {
    seed: "bergen-norway-wharf-houses",
    description: "A port city ringed by seven mountains, with coloured wooden houses on the old wharf that have stood since the Hanseatic League.",
  },
  "nordic/tromsø": {
    seed: "tromso-northern-lights-norway",
    description: "The aurora capital. Three months of polar night, dancing light overhead, and a warmth inside that makes perfect sense of why anyone stays.",
  },
  "nordic/stockholm": {
    seed: "stockholm-gamla-stan-sweden",
    description: "A city built across fourteen islands. The old town is compact and perfectly preserved. The waterways hold the whole thing together.",
  },
  "nordic/reykjavik": {
    seed: "reykjavik-colorful-iceland-harbor",
    description: "The world's northernmost capital — small, creative, and parked at the edge of a geologically restless island. Nothing here is accidental.",
  },
  "nordic/rovaniemi": {
    seed: "rovaniemi-lapland-snow-aurora",
    description: "On the Arctic Circle, where reindeer are real and the northern lights are a weather event. Winter here changes how you think about dark.",
  },
  // Peru
  "peru/cusco": {
    seed: "cusco-peru-inca-plaza",
    description: "The old Inca capital, now a city of Spanish colonial buildings on Inca stone foundations. At altitude — take the first day slowly.",
  },
  "peru/machu-picchu": {
    seed: "machu-picchu-ruins-clouds",
    description: "An Inca citadel above the clouds, built with a precision that still has no satisfying explanation. It earns every photograph ever taken of it.",
  },
  "peru/aguas-calientes": {
    seed: "aguas-calientes-peru-mountain",
    description: "The town at the foot of Machu Picchu — a base camp with good food, hot springs, and the mountain framing every window.",
  },
  "peru/pisac": {
    seed: "pisac-sacred-valley-terraces",
    description: "Inca agricultural terraces stepping down a hillside above the Sacred Valley. The Sunday market below has been running for centuries.",
  },
  "peru/lima": {
    seed: "lima-peru-pacific-cliffs",
    description: "Peru's sprawling capital sits on Pacific cliffs. The food here is seriously considered. Some of the continent's best restaurants are in Miraflores.",
  },
  // Santorini
  "santorini/fira": {
    seed: "fira-santorini-caldera-view",
    description: "The island's capital clings to the caldera rim. The views across to the volcano are everywhere — it takes time to stop noticing them.",
  },
  "santorini/oia": {
    seed: "oia-santorini-blue-dome-sunset",
    description: "The blue-domed village that appears in every Greek poster. The sunset is real. Arrive before the crowds do, and it remains extraordinary.",
  },
  "santorini/akrotiri": {
    seed: "akrotiri-santorini-ruins-ancient",
    description: "A Bronze Age city preserved under volcanic ash — Santorini's own Pompeii. Largely unexcavated, which makes it feel like a discovery.",
  },
  "santorini/kamari": {
    seed: "kamari-black-beach-santorini",
    description: "A black volcanic beach on the quieter eastern coast. The water is clear, the atmosphere is calmer, and the tavernas are the better for it.",
  },
  // Swiss Alps
  "swiss-alps/zermatt": {
    seed: "zermatt-matterhorn-snow-peak",
    description: "No cars. The Matterhorn above everything. A mountain town that takes the mountains more seriously than almost anywhere else on earth.",
  },
  "swiss-alps/interlaken": {
    seed: "interlaken-lake-mountains-switzerland",
    description: "Two lakes, the Jungfrau massif overhead, and a town that has been a jumping-off point for mountain adventures since the 1800s.",
  },
  "swiss-alps/jungfraujoch": {
    seed: "jungfraujoch-snow-alps-top",
    description: "The Top of Europe by train — a rack railway through the mountain to a station at 3,454 metres. The glacier from there is immense.",
  },
  "swiss-alps/lauterbrunnen": {
    seed: "lauterbrunnen-waterfalls-valley-alps",
    description: "A deep valley with seventy-two waterfalls coming off the cliffs. The light that reaches the bottom has already bounced off the Eiger.",
  },
  "swiss-alps/grindelwald": {
    seed: "grindelwald-alps-village-eiger",
    description: "A village under the north face of the Eiger. The hiking is world-class, the views are confrontational in the best possible way.",
  },
};

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lookupKey(destSlug: string, placeName: string): string {
  return `${destSlug}/${toSlug(placeName)}`;
}

export function getPlaceImageUrl(destSlug: string, placeName: string): string {
  const key = lookupKey(destSlug, placeName);
  const seed = PLACES[key]?.seed ?? `${destSlug}-${toSlug(placeName)}`;
  // picsum.photos: seeded, consistent, high-quality Unsplash content, no API key needed
  return `https://picsum.photos/seed/${seed}/480/300`;
}

export function getPlaceDescription(destSlug: string, placeName: string): string {
  const key = lookupKey(destSlug, placeName);
  return (
    PLACES[key]?.description ??
    `One of the ${placeName} experiences we build trips around — chosen for what it offers, not how often it appears in a listicle.`
  );
}
