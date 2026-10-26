/**
 * The words `tablewalk seed` makes rows from. Small on purpose: enough that
 * forty customers do not share a name, few enough to read in one sitting, and
 * no dependency to install (`npx tablewalk` has no build step). Every name is
 * made up; every address is example.com, which no mail ever reaches; every
 * phone number is in 555-01xx, the range kept for fiction.
 */

export const FIRST = [
  'Ada',
  'Amara',
  'Ben',
  'Carmen',
  'Chen',
  'Dana',
  'Diego',
  'Elena',
  'Eli',
  'Farah',
  'Grace',
  'Hana',
  'Ivan',
  'Jade',
  'Jonah',
  'Kai',
  'Lena',
  'Leo',
  'Maya',
  'Marcus',
  'Nadia',
  'Noah',
  'Omar',
  'Priya',
  'Quinn',
  'Rosa',
  'Sam',
  'Sofia',
  'Tariq',
  'Tess',
  'Uma',
  'Victor',
  'Wren',
  'Yusuf',
  'Zoe',
  'Ruth',
  'Owen',
  'Iris',
  'Hugo',
  'Mei',
];

export const LAST = [
  'Abbott',
  'Alvarez',
  'Bennett',
  'Brooks',
  'Castillo',
  'Chandler',
  'Dawson',
  'Delgado',
  'Ellis',
  'Fischer',
  'Foster',
  'Garcia',
  'Hale',
  'Hayes',
  'Ibarra',
  'Jensen',
  'Kaur',
  'Keller',
  'Lam',
  'Larsen',
  'Mendez',
  'Morgan',
  'Nakamura',
  'Novak',
  'Okafor',
  'Ortega',
  'Patel',
  'Price',
  'Quinlan',
  'Reyes',
  'Rossi',
  'Santos',
  'Shaw',
  'Tanaka',
  'Turner',
  'Underwood',
  'Vance',
  'Walsh',
  'Webb',
  'Young',
];

/* A company is two of these and a suffix: Harbor Supply Co., Northwind Labs. */
export const COMPANY_FIRST = [
  'Harbor',
  'Northwind',
  'Bluebird',
  'Cedar',
  'Copper',
  'Granite',
  'Juniper',
  'Lakeside',
  'Maple',
  'Meridian',
  'Oakline',
  'Pinecrest',
  'Redwood',
  'Riverbend',
  'Silverline',
  'Summit',
  'Sunrise',
  'Tidewater',
  'Westfield',
  'Willow',
];
export const COMPANY_LAST = ['Supply', 'Labs', 'Works', 'Partners', 'Group', 'Logistics', 'Studio', 'Foods', 'Health', 'Systems'];
export const COMPANY_SUFFIX = ['Co.', 'Inc.', 'LLC', ''];

export const CITIES = [
  'Springfield',
  'Riverton',
  'Fairview',
  'Greenville',
  'Madison',
  'Franklin',
  'Clinton',
  'Georgetown',
  'Salem',
  'Arlington',
  'Ashland',
  'Oxford',
  'Milton',
  'Dover',
  'Hudson',
];
export const STATES = ['CA', 'NY', 'TX', 'WA', 'OR', 'IL', 'MA', 'CO', 'GA', 'NC'];
export const STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Park Rd', 'Elm St', 'Lake View', 'Hill St', 'Pine Ct', 'Mill Rd'];

/* Things: a part, a product, an item — "Compact filter", "Heavy-duty bracket". */
export const THING_ADJ = ['Standard', 'Compact', 'Heavy-duty', 'Premium', 'Basic', 'Pro', 'Classic', 'Light', 'Large', 'Small'];
export const THING = [
  'bracket',
  'cable',
  'filter',
  'seal',
  'bearing',
  'valve',
  'panel',
  'sensor',
  'tire',
  'chain',
  'belt',
  'lamp',
  'clamp',
  'hose',
  'pad set',
  'kit',
  'mount',
  'switch',
  'spring',
  'grip',
];

/* A make and a model, for something people own and bring in: Halden Ridge 3. */
export const MAKES = ['Halden', 'Corvo', 'Brightline', 'Marlowe', 'Ostra', 'Vantor', 'Kestrel', 'Larkspur'];
export const MODELS = ['Ridge', 'Tempo', 'Atlas', 'Drift', 'Summit', 'Metro', 'Trail', 'Vista', 'Comet', 'Arc'];

export const COLORS = ['Black', 'White', 'Red', 'Blue', 'Green', 'Silver', 'Orange', 'Gray', 'Yellow', 'Teal'];

export const PRIORITY_WEIGHT: Record<string, number> = { low: 3, normal: 5, medium: 5, high: 2, urgent: 1, critical: 1 };
