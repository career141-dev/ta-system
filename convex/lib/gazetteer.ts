/**
 * Static Gazetteer Lookup Engine
 * 
 * Maps city/town/district/division names & aliases to canonical structured location:
 * { city: string | null, region: string | null, country: string | null }
 * 
 * Scoped initially to Sri Lanka, Bangladesh, UAE, India, Pakistan, Nepal, Philippines, Saudi Arabia, Qatar, UK, USA.
 */

export type StructuredLocation = {
  raw_text: string;
  city: string | null;
  region: string | null;
  country: string | null;
};

// Normalized static gazetteer mapping (keys stored lowercase & trimmed)
const GAZETTEER_DB: Record<string, { city: string | null; region: string | null; country: string }> = {
  // --- SRI LANKA ---
  "sri lanka": { city: null, region: null, country: "Sri Lanka" },
  "colombo": { city: "Colombo", region: "Western Province", country: "Sri Lanka" },
  "gampaha": { city: "Gampaha", region: "Western Province", country: "Sri Lanka" },
  "kalutara": { city: "Kalutara", region: "Western Province", country: "Sri Lanka" },
  "kandy": { city: "Kandy", region: "Central Province", country: "Sri Lanka" },
  "galle": { city: "Galle", region: "Southern Province", country: "Sri Lanka" },
  "jaffna": { city: "Jaffna", region: "Northern Province", country: "Sri Lanka" },
  "kurunegala": { city: "Kurunegala", region: "North Western Province", country: "Sri Lanka" },
  "ratnapura": { city: "Ratnapura", region: "Sabaragamuwa Province", country: "Sri Lanka" },
  "anuradhapura": { city: "Anuradhapura", region: "North Central Province", country: "Sri Lanka" },
  "badulla": { city: "Badulla", region: "Uva Province", country: "Sri Lanka" },
  "matara": { city: "Matara", region: "Southern Province", country: "Sri Lanka" },
  "batticaloa": { city: "Batticaloa", region: "Eastern Province", country: "Sri Lanka" },
  "trincomalee": { city: "Trincomalee", region: "Eastern Province", country: "Sri Lanka" },
  "negombo": { city: "Negombo", region: "Western Province", country: "Sri Lanka" },
  "dehiwala": { city: "Dehiwala", region: "Western Province", country: "Sri Lanka" },
  "mount lavinia": { city: "Dehiwala-Mount Lavinia", region: "Western Province", country: "Sri Lanka" },
  "moratuwa": { city: "Moratuwa", region: "Western Province", country: "Sri Lanka" },
  "kotte": { city: "Sri Jayawardenepura Kotte", region: "Western Province", country: "Sri Lanka" },
  "sri jayawardenepura": { city: "Sri Jayawardenepura Kotte", region: "Western Province", country: "Sri Lanka" },
  "battaramulla": { city: "Battaramulla", region: "Western Province", country: "Sri Lanka" },
  "nugegoda": { city: "Nugegoda", region: "Western Province", country: "Sri Lanka" },
  "maharagama": { city: "Maharagama", region: "Western Province", country: "Sri Lanka" },
  "malabe": { city: "Malabe", region: "Western Province", country: "Sri Lanka" },

  // --- BANGLADESH ---
  "bangladesh": { city: null, region: null, country: "Bangladesh" },
  "dhaka": { city: "Dhaka", region: "Dhaka Division", country: "Bangladesh" },
  "gazipur": { city: "Gazipur", region: "Dhaka Division", country: "Bangladesh" },
  "chattogram": { city: "Chattogram", region: "Chattogram Division", country: "Bangladesh" },
  "chittagong": { city: "Chattogram", region: "Chattogram Division", country: "Bangladesh" },
  "sylhet": { city: "Sylhet", region: "Sylhet Division", country: "Bangladesh" },
  "rajshahi": { city: "Rajshahi", region: "Rajshahi Division", country: "Bangladesh" },
  "khulna": { city: "Khulna", region: "Khulna Division", country: "Bangladesh" },
  "barishal": { city: "Barishal", region: "Barishal Division", country: "Bangladesh" },
  "barisal": { city: "Barishal", region: "Barishal Division", country: "Bangladesh" },
  "rangpur": { city: "Rangpur", region: "Rangpur Division", country: "Bangladesh" },
  "mymensingh": { city: "Mymensingh", region: "Mymensingh Division", country: "Bangladesh" },
  "narayanganj": { city: "Narayanganj", region: "Dhaka Division", country: "Bangladesh" },
  "cumilla": { city: "Cumilla", region: "Chattogram Division", country: "Bangladesh" },
  "comilla": { city: "Cumilla", region: "Chattogram Division", country: "Bangladesh" },
  "bogra": { city: "Bogra", region: "Rajshahi Division", country: "Bangladesh" },
  "bogura": { city: "Bogra", region: "Rajshahi Division", country: "Bangladesh" },
  "jessore": { city: "Jessore", region: "Khulna Division", country: "Bangladesh" },
  "jashore": { city: "Jessore", region: "Khulna Division", country: "Bangladesh" },
  "cox's bazar": { city: "Cox's Bazar", region: "Chattogram Division", country: "Bangladesh" },
  "coxs bazar": { city: "Cox's Bazar", region: "Chattogram Division", country: "Bangladesh" },

  // --- UAE ---
  "uae": { city: null, region: null, country: "United Arab Emirates" },
  "united arab emirates": { city: null, region: null, country: "United Arab Emirates" },
  "dubai": { city: "Dubai", region: "Emirate of Dubai", country: "United Arab Emirates" },
  "abu dhabi": { city: "Abu Dhabi", region: "Emirate of Abu Dhabi", country: "United Arab Emirates" },
  "sharjah": { city: "Sharjah", region: "Emirate of Sharjah", country: "United Arab Emirates" },
  "ajman": { city: "Ajman", region: "Emirate of Ajman", country: "United Arab Emirates" },
  "ras al khaimah": { city: "Ras Al Khaimah", region: "Emirate of Ras Al Khaimah", country: "United Arab Emirates" },
  "fujairah": { city: "Fujairah", region: "Emirate of Fujairah", country: "United Arab Emirates" },
  "umm al quwain": { city: "Umm Al Quwain", region: "Emirate of Umm Al Quwain", country: "United Arab Emirates" },
  "al ain": { city: "Al Ain", region: "Emirate of Abu Dhabi", country: "United Arab Emirates" },

  // --- INDIA ---
  "india": { city: null, region: null, country: "India" },
  "mumbai": { city: "Mumbai", region: "Maharashtra", country: "India" },
  "delhi": { city: "Delhi", region: "NCR", country: "India" },
  "new delhi": { city: "New Delhi", region: "NCR", country: "India" },
  "bengaluru": { city: "Bengaluru", region: "Karnataka", country: "India" },
  "bangalore": { city: "Bengaluru", region: "Karnataka", country: "India" },
  "hyderabad": { city: "Hyderabad", region: "Telangana", country: "India" },
  "chennai": { city: "Chennai", region: "Tamil Nadu", country: "India" },
  "kolkata": { city: "Kolkata", region: "West Bengal", country: "India" },
  "pune": { city: "Pune", region: "Maharashtra", country: "India" },
  "ahmedabad": { city: "Ahmedabad", region: "Gujarat", country: "India" },
  "noida": { city: "Noida", region: "Uttar Pradesh", country: "India" },
  "gurgaon": { city: "Gurugram", region: "Haryana", country: "India" },
  "gurugram": { city: "Gurugram", region: "Haryana", country: "India" },
  "kochi": { city: "Kochi", region: "Kerala", country: "India" },
  "trivandrum": { city: "Thiruvananthapuram", region: "Kerala", country: "India" },

  // --- PAKISTAN ---
  "pakistan": { city: null, region: null, country: "Pakistan" },
  "karachi": { city: "Karachi", region: "Sindh", country: "Pakistan" },
  "lahore": { city: "Lahore", region: "Punjab", country: "Pakistan" },
  "islamabad": { city: "Islamabad", region: "ICT", country: "Pakistan" },
  "rawalpindi": { city: "Rawalpindi", region: "Punjab", country: "Pakistan" },
  "faisalabad": { city: "Faisalabad", region: "Punjab", country: "Pakistan" },
  "peshawar": { city: "Peshawar", region: "Khyber Pakhtunkhwa", country: "Pakistan" },
  "multan": { city: "Multan", region: "Punjab", country: "Pakistan" },

  // --- NEPAL ---
  "nepal": { city: null, region: null, country: "Nepal" },
  "kathmandu": { city: "Kathmandu", region: "Bagmati", country: "Nepal" },
  "pokhara": { city: "Pokhara", region: "Gandaki", country: "Nepal" },
  "lalitpur": { city: "Lalitpur", region: "Bagmati", country: "Nepal" },

  // --- PHILIPPINES ---
  "philippines": { city: null, region: null, country: "Philippines" },
  "manila": { city: "Manila", region: "Metro Manila", country: "Philippines" },
  "quezon city": { city: "Quezon City", region: "Metro Manila", country: "Philippines" },
  "cebu": { city: "Cebu City", region: "Central Visayas", country: "Philippines" },
  "davao": { city: "Davao City", region: "Davao Region", country: "Philippines" },
  "makati": { city: "Makati", region: "Metro Manila", country: "Philippines" },

  // --- SAUDI ARABIA ---
  "saudi arabia": { city: null, region: null, country: "Saudi Arabia" },
  "ksa": { city: null, region: null, country: "Saudi Arabia" },
  "riyadh": { city: "Riyadh", region: "Riyadh Province", country: "Saudi Arabia" },
  "jeddah": { city: "Jeddah", region: "Makkah Province", country: "Saudi Arabia" },
  "dammam": { city: "Dammam", region: "Eastern Province", country: "Saudi Arabia" },
  "khobar": { city: "Khobar", region: "Eastern Province", country: "Saudi Arabia" },
  "mecca": { city: "Mecca", region: "Makkah Province", country: "Saudi Arabia" },
  "medina": { city: "Medina", region: "Al Madinah Province", country: "Saudi Arabia" },

  // --- QATAR ---
  "qatar": { city: null, region: null, country: "Qatar" },
  "doha": { city: "Doha", region: "Ad Dawhah", country: "Qatar" },
  "al wakrah": { city: "Al Wakrah", region: "Al Wakrah", country: "Qatar" },
  "al rayyan": { city: "Al Rayyan", region: "Al Rayyan", country: "Qatar" },

  // --- UNITED KINGDOM & USA ---
  "uk": { city: null, region: null, country: "United Kingdom" },
  "united kingdom": { city: null, region: null, country: "United Kingdom" },
  "london": { city: "London", region: "England", country: "United Kingdom" },
  "manchester": { city: "Manchester", region: "England", country: "United Kingdom" },
  "birmingham": { city: "Birmingham", region: "England", country: "United Kingdom" },
  "usa": { city: null, region: null, country: "United States" },
  "united states": { city: null, region: null, country: "United States" },
  "new york": { city: "New York", region: "New York", country: "United States" },
  "san francisco": { city: "San Francisco", region: "California", country: "United States" },
  "chicago": { city: "Chicago", region: "Illinois", country: "United States" },
};

/**
 * Resolves raw text via static gazetteer database.
 * Returns StructuredLocation if hit, or null if miss.
 */
export function resolveLocationViaGazetteer(rawText: string): StructuredLocation | null {
  if (!rawText || typeof rawText !== "string") return null;

  const normalized = rawText.trim().toLowerCase();
  if (!normalized) return null;

  // 1. Direct key lookup
  if (GAZETTEER_DB[normalized]) {
    const hit = GAZETTEER_DB[normalized];
    return {
      raw_text: rawText,
      city: hit.city,
      region: hit.region,
      country: hit.country,
    };
  }

  // 2. Tokenized search for composite text like "Gazipur, Bangladesh" or "Colombo 03, Sri Lanka"
  for (const [key, hit] of Object.entries(GAZETTEER_DB)) {
    // Word boundary or substring match for key in normalized string
    const regex = new RegExp(`\\b${key}\\b`, "i");
    if (regex.test(normalized)) {
      return {
        raw_text: rawText,
        city: hit.city,
        region: hit.region,
        country: hit.country,
      };
    }
  }

  return null;
}
