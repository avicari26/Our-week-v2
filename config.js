// Our Week: the only file you need to edit.
//
// Get both values from your Supabase project:
//   SUPABASE_URL              Project Settings > Data API > Project URL   (https://xxxx.supabase.co)
//   SUPABASE_PUBLISHABLE_KEY  Project Settings > API Keys > starts with sb_publishable_
// Never put a secret key (sb_secret_) here. This file is sent to every browser.

export const CONFIG = {
  SUPABASE_URL: "https://advroacjsgincnfnjhkf.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_jqj9PZBGQb5G47sjhB5n7Q_WabT91MK",

  APP_NAME: "Our Week",
  VAPID_PUBLIC_KEY: "BMDpCCqe4v6eS5JHIojDb4MSmwBApD-08YdYfJvUQQlm7BfvMM9eBPw_prkT0TZ3_qzcLqAmMjcdSL7r9skhmSc",
  
  // Photo settings
  MAX_EDGE: 1600,       // longest side after compression, in pixels
  JPEG_QUALITY: 0.82,

  MAX_CIRCLE_SIZE: 25,  // also enforced in the database

  REACTIONS: ["❤️", "😂", "😭", "🔥", "👀"],

  // Daily prompts, one per day, shared by every circle.
  PROMPTS: [
    "Something that made you laugh today",
    "What you ate that was actually good",
    "The view from where you are right now",
    "A color you noticed",
    "Something you'd want them to see if they were here",
    "Your morning",
    "A small win",
    "Something ugly that you love anyway",
    "The sky today",
    "Where you spent the most time",
    "A thing you almost bought",
    "Something that reminded you of someone in this circle",
    "Your hands doing something",
    "The best light of the day",
    "A stranger's dog",
    "What's on your desk or table",
    "The most boring part of your day",
    "A door",
    "Something you're looking forward to",
    "Proof you went outside",
    "The last thing you looked at before bed",
    "Your shoes, wherever they are",
    "Something green",
    "A text you wanted to send but took a photo instead",
    "The weirdest thing you saw",
    "A place you'd take the whole circle",
    "Coffee, tea, or whatever got you through",
    "Something old",
  ],
};
