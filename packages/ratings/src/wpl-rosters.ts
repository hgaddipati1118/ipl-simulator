/**
 * WPL 2025 team rosters.
 * Maps team IDs to arrays of player objects with auction/retention prices.
 * Player names should match ESPN player database (longName field).
 *
 * Prices are in crores (INR). Sources:
 *   - WPL 2025 auction (Dec 15, 2024, Bengaluru)
 *   - CricTracker, Olympics.com, ESPNCricinfo
 */

export interface WPLRosterPlayer {
  name: string;
  price: number;      // in crores (e.g., 3.4 for Mandhana)
  retained?: boolean;  // true if retained pre-auction
}

export interface WPLRoster {
  teamId: string;
  teamName: string;
  shortName: string;
  players: WPLRosterPlayer[];
}

// ---------------------------------------------------------------------------
// WPL 2025 Rosters (after Dec 2024 auction)
// ---------------------------------------------------------------------------

export const WPL_2025_ROSTERS: WPLRoster[] = [
  {
    teamId: "mi-w",
    teamName: "Mumbai Indians Women",
    shortName: "MI",
    players: [
      { name: "Harmanpreet Kaur", price: 1.80, retained: true },
      { name: "Nat Sciver-Brunt", price: 3.20, retained: true },
      { name: "Amelia Kerr", price: 1.00, retained: true },
      { name: "Pooja Vastrakar", price: 1.90, retained: true },
      { name: "Yastika Bhatia", price: 1.50, retained: true },
      { name: "Amanjot Kaur", price: 0.50 },
      { name: "Saika Ishaque", price: 0.10 },
      { name: "Hayley Matthews", price: 0.40 },
      { name: "Chloe Tryon", price: 0.30 },
      { name: "Shabnim Ismail", price: 1.20 },
      { name: "Nadine de Klerk", price: 0.30 },
      { name: "Sajeevan Sajana", price: 0.15 },
      { name: "Gunalan Kamalini", price: 1.60 },
      { name: "Jintimani Kalita", price: 0.10 },
      { name: "Amandeep Kaur", price: 0.10 },
      { name: "Sanskriti Gupta", price: 0.10 },
      { name: "SB Keerthana", price: 0.10 },
      { name: "Akshita Maheshwari", price: 0.20 },
    ],
  },
  {
    teamId: "dc-w",
    teamName: "Delhi Capitals Women",
    shortName: "DC",
    players: [
      { name: "Jemimah Rodrigues", price: 2.20, retained: true },
      { name: "Meg Lanning", price: 1.10, retained: true },
      { name: "Shafali Verma", price: 2.00, retained: true },
      { name: "Marizanne Kapp", price: 1.50, retained: true },
      { name: "Alice Capsey", price: 0.75 },
      { name: "Radha Yadav", price: 0.40 },
      { name: "Shikha Pandey", price: 0.60 },
      { name: "Titas Sadhu", price: 0.25 },
      { name: "Minnu Mani", price: 0.30 },
      { name: "Taniya Bhatia", price: 0.30 },
      { name: "Jess Jonassen", price: 0.50 },
      { name: "Sneha Deepthi", price: 0.30 },
      { name: "Arundhati Reddy", price: 0.30 },
      { name: "Annabel Sutherland", price: 2.00 },
      { name: "Nandini Kashyap", price: 0.10 },
      { name: "Niki Prasad", price: 0.10 },
      { name: "Sarah Bryce", price: 0.10 },
      { name: "N Charani", price: 0.55 },
    ],
  },
  {
    teamId: "rcb-w",
    teamName: "Royal Challengers Bengaluru Women",
    shortName: "RCB",
    players: [
      { name: "Smriti Mandhana", price: 3.40, retained: true },
      { name: "Ellyse Perry", price: 1.70, retained: true },
      { name: "Richa Ghosh", price: 1.90, retained: true },
      { name: "Renuka Singh", price: 1.50, retained: true },
      { name: "Sophie Devine", price: 0.50 },
      { name: "Georgia Wareham", price: 0.40 },
      { name: "Shreyanka Patil", price: 0.10 },
      { name: "Asha Sobhana", price: 0.10 },
      { name: "Sophie Molineux", price: 0.30 },
      { name: "Kate Cross", price: 0.30 },
      { name: "Ekta Bisht", price: 0.60 },
      { name: "Danni Wyatt-Hodge", price: 0.30 },
      { name: "Kanika Ahuja", price: 0.35 },
      { name: "Sabbineni Meghana", price: 0.30 },
      { name: "Prema Rawat", price: 1.20 },
      { name: "Joshitha VJ", price: 0.10 },
      { name: "Raghvi Bist", price: 0.10 },
      { name: "Jagravi Pawar", price: 0.10 },
    ],
  },
  {
    teamId: "gg-w",
    teamName: "Gujarat Giants Women",
    shortName: "GG",
    players: [
      { name: "Ashleigh Gardner", price: 3.20, retained: true },
      { name: "Laura Wolvaardt", price: 2.00, retained: true },
      { name: "Beth Mooney", price: 0.40, retained: true },
      { name: "Kashvee Gautam", price: 2.00 },
      { name: "Simran Shaikh", price: 1.90 },
      { name: "Deandra Dottin", price: 1.70 },
      { name: "Phoebe Litchfield", price: 1.00 },
      { name: "Harleen Deol", price: 0.40 },
      { name: "Dayalan Hemalatha", price: 0.30 },
      { name: "Tanuja Kanwar", price: 0.50 },
      { name: "Meghna Singh", price: 0.30 },
      { name: "Danielle Gibson", price: 0.30 },
      { name: "Priya Mishra", price: 0.20 },
      { name: "Shabnam Shakil", price: 0.10 },
      { name: "Mannat Kashyap", price: 0.10 },
      { name: "Prakashika Naik", price: 0.10 },
      { name: "Bharti Fulmali", price: 0.10 },
      { name: "Sayali Satghare", price: 0.10 },
    ],
  },
  {
    teamId: "upw",
    teamName: "UP Warriorz",
    shortName: "UPW",
    players: [
      { name: "Deepti Sharma", price: 2.60, retained: true },
      { name: "Sophie Ecclestone", price: 1.80, retained: true },
      { name: "Tahlia McGrath", price: 1.40, retained: true },
      { name: "Alyssa Healy", price: 0.70 },
      { name: "Chamari Athapaththu", price: 0.50 },
      { name: "Grace Harris", price: 0.75 },
      { name: "Anjali Sarvani", price: 0.55 },
      { name: "Rajeshwari Gayakwad", price: 0.40 },
      { name: "Shweta Sehrawat", price: 0.40 },
      { name: "Kiran Navgire", price: 0.30 },
      { name: "Vrinda Dinesh", price: 1.30 },
      { name: "Gouher Sultana", price: 0.30 },
      { name: "Alana King", price: 0.30 },
      { name: "Poonam Khemnar", price: 0.10 },
      { name: "Saima Thakor", price: 0.10 },
      { name: "Arushi Goel", price: 0.10 },
      { name: "Kranti Goud", price: 0.10 },
      { name: "Uma Chetry", price: 0.10 },
    ],
  },
];
