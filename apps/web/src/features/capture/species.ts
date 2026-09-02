// Species picker reference list (F1). Not a shared payload shape — catchSchema.species is a
// free-text slug — so this lives client-side rather than in packages/schema. Curated toward the
// packet's TN/SC personas; "other" always lets a real catch through the free-text search below.
export interface Species {
  slug: string
  label: string
}

export const SPECIES: Species[] = [
  { slug: 'largemouth_bass', label: 'Largemouth Bass' },
  { slug: 'smallmouth_bass', label: 'Smallmouth Bass' },
  { slug: 'spotted_bass', label: 'Spotted Bass' },
  { slug: 'striped_bass', label: 'Striped Bass' },
  { slug: 'white_bass', label: 'White Bass' },
  { slug: 'hybrid_striped_bass', label: 'Hybrid Striped Bass' },
  { slug: 'bluegill', label: 'Bluegill' },
  { slug: 'redear_sunfish', label: 'Redear Sunfish' },
  { slug: 'black_crappie', label: 'Black Crappie' },
  { slug: 'white_crappie', label: 'White Crappie' },
  { slug: 'channel_catfish', label: 'Channel Catfish' },
  { slug: 'blue_catfish', label: 'Blue Catfish' },
  { slug: 'flathead_catfish', label: 'Flathead Catfish' },
  { slug: 'rainbow_trout', label: 'Rainbow Trout' },
  { slug: 'brown_trout', label: 'Brown Trout' },
  { slug: 'brook_trout', label: 'Brook Trout' },
  { slug: 'walleye', label: 'Walleye' },
  { slug: 'sauger', label: 'Sauger' },
  { slug: 'common_carp', label: 'Common Carp' },
  { slug: 'longnose_gar', label: 'Longnose Gar' },
  { slug: 'other', label: 'Other' },
]
