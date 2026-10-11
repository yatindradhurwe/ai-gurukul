// Demo seed content. The lesson text is original summary material written for
// this demo — NOT reproduced from any textbook — and is marked as pending
// subject-expert review. Exam weightage is deliberately left NULL: the
// planner must not invent weightage that has not been verified.

export const PLANS = [
  {
    code: "free",
    name: "Free",
    price_paise: 0,
    billing_period: "none",
    audience: "student",
    entitlements: {
      courses: "sample", ai_questions_per_month: 20, avatar_lessons_per_month: 2, avatar_live_minutes_per_month: 0,
      practice_tests: "basic", progress_reports: "basic", teacher_tools: false, custom_branding: false, admin_analytics: "none",
    },
  },
  {
    code: "student_pro_monthly",
    name: "Student Pro (monthly)",
    price_paise: 29900,
    billing_period: "monthly",
    audience: "student",
    entitlements: {
      courses: "catalog", ai_questions_per_month: 600, avatar_lessons_per_month: 40, avatar_live_minutes_per_month: 30,
      practice_tests: "expanded", progress_reports: "detailed", teacher_tools: false, custom_branding: false, admin_analytics: "personal",
    },
  },
  {
    code: "student_pro_annual",
    name: "Student Pro (annual)",
    price_paise: 299000,
    billing_period: "annual",
    audience: "student",
    entitlements: {
      courses: "catalog", ai_questions_per_month: 600, avatar_lessons_per_month: 40, avatar_live_minutes_per_month: 30,
      practice_tests: "expanded", progress_reports: "detailed", teacher_tools: false, custom_branding: false, admin_analytics: "personal",
    },
  },
  {
    code: "institution_monthly",
    name: "Institution (per student seat, monthly)",
    price_paise: 15000,
    billing_period: "monthly",
    audience: "institution",
    entitlements: {
      courses: "licensed", ai_questions_per_month: 20000, avatar_lessons_per_month: 2000, avatar_live_minutes_per_month: 500,
      practice_tests: "institutional", progress_reports: "institutional", teacher_tools: true, custom_branding: false, admin_analytics: "institutional",
    },
  },
  {
    code: "white_label_monthly",
    name: "White-label (per seat, monthly)",
    price_paise: 30000,
    billing_period: "monthly",
    audience: "white_label",
    entitlements: {
      courses: "licensed", ai_questions_per_month: 40000, avatar_lessons_per_month: 4000, avatar_live_minutes_per_month: 1000,
      practice_tests: "institutional", progress_reports: "institutional", teacher_tools: true, custom_branding: true, admin_analytics: "institutional",
    },
  },
];

interface SeedTopic {
  key: string;
  title: string;
  difficulty: number;
  minutes: number;
  prereqs?: string[];
  lesson: string;
}

interface SeedChapter {
  title: string;
  topics: SeedTopic[];
}

export const SCIENCE_CHAPTERS: SeedChapter[] = [
  {
    title: "Crop Production and Management",
    topics: [
      {
        key: "crop-types",
        title: "Types of crops and agricultural practices",
        difficulty: 2,
        minutes: 40,
        lesson:
          "Crops are plants of the same kind grown on a large scale. In India, kharif crops such as paddy and maize are sown in the rainy season, around June to September. Rabi crops such as wheat and mustard are grown in winter, from about October to March.\n\nGrowing a crop follows a sequence of agricultural practices: preparing the soil, sowing seeds, adding manure and fertilisers, irrigation, protecting the crop from weeds, harvesting, and storage.",
      },
      {
        key: "soil-irrigation",
        title: "Soil preparation, manure and irrigation",
        difficulty: 3,
        minutes: 45,
        prereqs: ["crop-types"],
        lesson:
          "Ploughing loosens and turns the soil so roots can breathe and grow deeper, and it brings nutrient-rich soil to the top. Levelling the field after ploughing helps water spread evenly and reduces erosion.\n\nManure is organic material made from decomposed plant and animal waste; it improves soil texture and water-holding capacity. Fertilisers are chemical substances rich in specific nutrients such as nitrogen, phosphorus and potassium. Overuse of fertilisers can harm soil health and pollute water.\n\nIrrigation is supplying water to crops at regular intervals. Modern methods such as sprinkler and drip irrigation save water compared to traditional flooding.",
      },
    ],
  },
  {
    title: "Microorganisms: Friend and Foe",
    topics: [
      {
        key: "micro-types",
        title: "Types of microorganisms",
        difficulty: 2,
        minutes: 40,
        lesson:
          "Microorganisms are living things too small to see with the naked eye; a microscope is needed to observe them. The main groups are bacteria, fungi, protozoa and algae. Viruses are also microscopic, but they reproduce only inside the cells of a host organism.\n\nMicroorganisms live almost everywhere: in soil, water, air and inside the bodies of plants and animals.",
      },
      {
        key: "micro-uses",
        title: "Useful and harmful microorganisms",
        difficulty: 3,
        minutes: 50,
        prereqs: ["micro-types"],
        lesson:
          "Some microorganisms are useful. Lactobacillus bacteria turn milk into curd. Yeast is used in baking because it releases carbon dioxide during fermentation, which makes dough rise. Certain bacteria in the roots of leguminous plants fix atmospheric nitrogen into the soil, increasing fertility. Antibiotics such as penicillin are made from microorganisms.\n\nOther microorganisms cause disease. Diseases that spread from an infected person to a healthy person are called communicable diseases, for example cholera and tuberculosis. Vaccination helps the body build protection against specific disease-causing microbes.",
      },
    ],
  },
  {
    title: "Force and Pressure",
    topics: [
      {
        key: "force-basics",
        title: "Force as a push or pull",
        difficulty: 2,
        minutes: 40,
        lesson:
          "A force is a push or a pull on an object. Forces arise from the interaction between two objects. A force can change the speed of an object, change its direction of motion, or change its shape.\n\nForces applied in the same direction add up, while forces applied in opposite directions partly or fully cancel. The strength of a force is measured in newtons (N).",
      },
      {
        key: "contact-forces",
        title: "Contact and non-contact forces",
        difficulty: 3,
        minutes: 45,
        prereqs: ["force-basics"],
        lesson:
          "Contact forces act only when objects touch, such as muscular force and friction. Non-contact forces act from a distance: magnetic force, electrostatic force and the force of gravity.\n\nGravity is the force with which the Earth pulls every object towards itself. Every object in the universe attracts every other object with a gravitational force.",
      },
      {
        key: "pressure",
        title: "Pressure in solids, liquids and gases",
        difficulty: 4,
        minutes: 55,
        prereqs: ["force-basics"],
        lesson:
          "Pressure is the force acting per unit area: pressure = force ÷ area. For the same force, a smaller area produces greater pressure. This is why knives have sharp edges and why porters place a round cloth on their heads to spread the load over a larger area.\n\nLiquids exert pressure on the walls of their container, and the pressure increases with depth. Gases also exert pressure. The air around us exerts atmospheric pressure, which we do not feel because the pressure inside our bodies balances it.",
      },
    ],
  },
  {
    title: "Friction",
    topics: [
      {
        key: "friction-basics",
        title: "Friction and the factors affecting it",
        difficulty: 3,
        minutes: 45,
        prereqs: ["contact-forces"],
        lesson:
          "Friction is a contact force that opposes the relative motion between two surfaces in contact. It is caused by the interlocking of tiny irregularities on the surfaces. Rougher surfaces produce more friction, and pressing surfaces together harder increases friction.\n\nStatic friction acts before an object starts moving; sliding friction acts while it slides, and is slightly smaller than static friction. Rolling friction is much smaller than sliding friction, which is why wheels and ball bearings make movement easier.",
      },
      {
        key: "friction-control",
        title: "Increasing and reducing friction",
        difficulty: 3,
        minutes: 40,
        prereqs: ["friction-basics"],
        lesson:
          "Friction is sometimes useful: it lets us walk, write and brake a bicycle. Treads on tyres and soles of shoes increase friction for better grip.\n\nFriction can also be wasteful because it produces heat and wears out parts. It can be reduced by lubricants such as oil and grease, by using wheels and ball bearings, and by streamlined shapes that reduce fluid friction (drag) in air and water.",
      },
    ],
  },
  {
    title: "Sound",
    topics: [
      {
        key: "sound-vibration",
        title: "Sound is produced by vibration",
        difficulty: 2,
        minutes: 40,
        lesson:
          "Sound is produced when an object vibrates. A vibration is a rapid to-and-fro motion. In humans, sound is produced by the vibration of the vocal cords in the larynx.\n\nSound needs a medium such as a solid, liquid or gas to travel. It cannot travel through a vacuum, which is why there is no sound in outer space.",
      },
      {
        key: "sound-properties",
        title: "Amplitude, frequency, loudness and pitch",
        difficulty: 4,
        minutes: 55,
        prereqs: ["sound-vibration"],
        lesson:
          "The number of vibrations per second is the frequency, measured in hertz (Hz). A higher frequency produces a higher pitch. The size of the vibration is its amplitude; a larger amplitude produces a louder sound. Loudness is measured in decibels (dB).\n\nHumans can hear sounds roughly between 20 Hz and 20,000 Hz. Unpleasant, unwanted sound is called noise, and long exposure to loud noise can damage hearing.",
      },
    ],
  },
  {
    title: "Chemical Effects of Electric Current",
    topics: [
      {
        key: "conduction-liquids",
        title: "Conduction of electricity in liquids",
        difficulty: 3,
        minutes: 45,
        lesson:
          "Some liquids conduct electricity and some do not. Liquids that conduct electricity are called good conductors; most of them are solutions of acids, bases and salts. Distilled water is a poor conductor, but tap water conducts because it contains dissolved salts.\n\nA tester with a bulb or an LED can be used to check whether a liquid conducts. An LED glows even with a weak current, so it is useful for testing liquids that conduct poorly.",
      },
      {
        key: "electroplating",
        title: "Chemical effects and electroplating",
        difficulty: 4,
        minutes: 50,
        prereqs: ["conduction-liquids"],
        lesson:
          "When electric current passes through a conducting solution, it can cause chemical changes: bubbles of gas may form at the electrodes, metal may be deposited, or the colour of the solution may change.\n\nElectroplating is the process of depositing a thin layer of a desired metal on another material using electricity. For example, chromium plating gives a shiny, scratch-resistant surface, and iron is coated with zinc to protect it from rusting.",
      },
    ],
  },
];

/** A short diagnostic quiz across chapters (teacher-reviewed in a real deployment). */
export const DIAGNOSTIC_QUESTIONS: { topic: string; type: "mcq" | "numeric" | "short_answer"; prompt: string; options?: string[]; answer_key: unknown; marks: number }[] = [
  { topic: "crop-types", type: "mcq", prompt: "Which of these is a rabi crop?", options: ["Paddy", "Maize", "Wheat", "Cotton"], answer_key: { correct: 2 }, marks: 1 },
  { topic: "micro-uses", type: "mcq", prompt: "Which microorganism makes bread dough rise?", options: ["Lactobacillus", "Yeast", "Rhizobium", "Amoeba"], answer_key: { correct: 1 }, marks: 1 },
  { topic: "force-basics", type: "short_answer", prompt: "What is the SI unit of force?", answer_key: { accepted: ["newton", "newtons", "N"] }, marks: 1 },
  { topic: "pressure", type: "numeric", prompt: "A force of 100 N acts on an area of 4 m². What is the pressure in N/m²?", answer_key: { value: 25, tolerance: 0.01 }, marks: 2 },
  { topic: "pressure", type: "mcq", prompt: "Why do knives have sharp edges?", options: ["To look attractive", "To reduce area and increase pressure", "To increase area", "To reduce friction"], answer_key: { correct: 1 }, marks: 1 },
  { topic: "friction-basics", type: "mcq", prompt: "Which type of friction is the smallest?", options: ["Static", "Sliding", "Rolling", "All are equal"], answer_key: { correct: 2 }, marks: 1 },
  { topic: "sound-properties", type: "mcq", prompt: "A higher frequency of vibration produces a…", options: ["Louder sound", "Higher pitch", "Lower pitch", "Softer sound"], answer_key: { correct: 1 }, marks: 1 },
  { topic: "electroplating", type: "mcq", prompt: "Iron is coated with zinc mainly to…", options: ["Make it heavier", "Protect it from rusting", "Make it magnetic", "Increase conductivity"], answer_key: { correct: 1 }, marks: 1 },
];
