/**
 * Cinematic vignette pools for Tickle Maze.
 * Types: feet (shoes), belly (shirt), tied (pants)
 */
window.SCENE_POOLS = {
  feet: [
    {
      title: "Sole Surrender",
      text: "She plucks off your shoes and pins your ankles. Soft, relentless fingers dance across your bare soles — every arch, every toe.",
      captions: ["Heehee~ those toes curl so sweetly!", "No escape for ticklish feet!", "Wiggle all you want~"]
    },
    {
      title: "Toe Trap",
      text: "A minion giggles and wraps silk around your ankles, then feather-ticks between your toes until you kick helplessly.",
      captions: ["Between the toes~!", "Such sensitive little piggies!", "Tap faster or giggle forever~"]
    },
    {
      title: "Arch Assault",
      text: "The succubus presses her thumbs into your arches in slow, wicked circles while whispering teasing nothings.",
      captions: ["Right on the arches~", "Your feet betray you!", "Don't you dare laugh~"]
    },
    {
      title: "Stocking Snatch",
      text: "Your footwear vanishes in a puff of magenta smoke. Cool stone air hits bare soles — then a hundred light fingertip taps.",
      captions: ["Bare soles in the manor~", "Tap-tap-tickle!", "She's merciless today!"]
    },
    {
      title: "Foot Feast",
      text: "Two minions hold your legs while the succubus trails a glowing feather from heel to tip, laughing at every twitch.",
      captions: ["Feather of doom~", "Heel to tip… again!", "Your resistance is adorable!"]
    }
  ],
  belly: [
    {
      title: "Flank Frenzy",
      text: "Cool claws skim under your shirt and find every soft spot along your flanks. You squirm as the stone halls echo your laughter.",
      captions: ["Sides are fair game~", "No armor for the midriff!", "Giggle for me~"]
    },
    {
      title: "Navel Nest",
      text: "A minion discovers your belly and treats it like a playground — light circles, sudden scribbles, wicked pauses.",
      captions: ["Belly button blues~", "Scribble scribble!", "You're melting!"]
    },
    {
      title: "Ribcage Rondo",
      text: "The succubus walks her fingers up your ribs like a piano, then back down in fluttering runs that leave you breathless.",
      captions: ["Tickle scales~", "Up and down the ribs!", "Keep tapping!"]
    },
    {
      title: "Shirt Lift",
      text: "Your shirt is tugged up just enough. Warm breath and colder fingertips explore the exposed skin until you writhe.",
      captions: ["Just a little lift~", "So soft under there!", "Resist, explorer!"]
    },
    {
      title: "Flank Sandwich",
      text: "Minions attack both sides at once while the succubus watches, chin on hand, thoroughly entertained.",
      captions: ["Left and right~!", "No safe flank!", "Double trouble!"]
    }
  ],
  tied: [
    {
      title: "Silk Bind",
      text: "Magical ribbons yank you flat against a stone pillar. Bound at wrists and ankles, you can only thrash as tickles rain everywhere.",
      captions: ["Tied tight~", "Nowhere to run!", "Struggle cutely~"]
    },
    {
      title: "Altar of Giggles",
      text: "You're laid across a glowing rune-carved slab. Pants tugged just so, the whole crew takes turns finding your weakest spots.",
      captions: ["Manor altar special~", "Everyone gets a turn!", "Resist the ritual!"]
    },
    {
      title: "Webbed & Wriggling",
      text: "Sticky spider-silk (succubus special) cocoon-wraps your legs. Helpless, you endure a coordinated tickle assault.",
      captions: ["Caught in the web~", "Wriggle wriggle!", "Freedom takes taps!"]
    }
  ]
};

window.pickScene = function pickScene(clothing) {
  // Prefer scene types matching still-worn clothing; otherwise any
  const order = [];
  if (clothing.shoes) order.push("feet");
  if (clothing.shirt) order.push("belly");
  if (clothing.pants) order.push("tied");
  if (!order.length) order.push("feet", "belly", "tied");

  const type = order[Math.floor(Math.random() * order.length)];
  const pool = window.SCENE_POOLS[type];
  const scene = pool[Math.floor(Math.random() * pool.length)];
  return { type, scene, clothingPiece: type === "feet" ? "shoes" : type === "belly" ? "shirt" : "pants" };
};
