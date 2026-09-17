/**
 * Cinematic vignette pools for Tickle Maze.
 * Types: feet (shoes), belly (shirt), tied (pants)
 * Scene stills reused with distinct captions / tint variants so each pool is complete.
 */
window.SCENE_POOLS = {
  feet: [
    {
      title: "Sole Surrender",
      text: "She plucks off your shoes and pins your ankles. Soft, relentless fingers dance across your bare soles — every arch, every toe.",
      captions: ["Heehee~ those toes curl so sweetly!", "No escape for ticklish feet!", "Wiggle all you want~"],
      image: "assets/scenes/feet-styled.png",
      imageFallback: "assets/scenes/feet-01.png",
      tint: null,
      crop: "center"
    },
    {
      title: "Toe Trap",
      text: "A minion giggles and wraps silk around your ankles, then feather-ticks between your toes until you kick helplessly.",
      captions: ["Between the toes~!", "Such sensitive little piggies!", "Tap faster or giggle forever~"],
      image: "assets/scenes/feet-styled.png",
      imageFallback: "assets/scenes/feet-01.png",
      tint: "rose",
      crop: "left"
    },
    {
      title: "Arch Assault",
      text: "The succubus presses her thumbs into your arches in slow, wicked circles while whispering teasing nothings.",
      captions: ["Right on the arches~", "Your feet betray you!", "Don't you dare laugh~"],
      image: "assets/scenes/feet-styled.png",
      imageFallback: "assets/scenes/feet-01.png",
      tint: "magenta",
      crop: "right"
    },
    {
      title: "Stocking Snatch",
      text: "Your footwear vanishes in a puff of magenta smoke. Cool stone air hits bare soles — then a hundred light fingertip taps.",
      captions: ["Bare soles in the manor~", "Tap-tap-tickle!", "She's merciless today!"],
      image: "assets/scenes/feet-styled.png",
      imageFallback: "assets/scenes/feet-01.png",
      tint: "violet",
      crop: "top"
    },
    {
      title: "Foot Feast",
      text: "Two minions hold your legs while the succubus trails a glowing feather from heel to tip, laughing at every twitch.",
      captions: ["Feather of doom~", "Heel to tip… again!", "Your resistance is adorable!"],
      image: "assets/scenes/feet-styled.png",
      imageFallback: "assets/scenes/feet-01.png",
      tint: "warm",
      crop: "bottom"
    }
  ],
  belly: [
    {
      title: "Flank Frenzy",
      text: "Cool claws skim under your shirt and find every soft spot along your flanks. You squirm as the stone halls echo your laughter.",
      captions: ["Sides are fair game~", "No armor for the midriff!", "Giggle for me~"],
      image: "assets/scenes/belly-styled.png",
      imageFallback: "assets/scenes/belly-01.png",
      tint: null,
      crop: "center"
    },
    {
      title: "Navel Nest",
      text: "A minion discovers your belly and treats it like a playground — light circles, sudden scribbles, wicked pauses.",
      captions: ["Belly button blues~", "Scribble scribble!", "You're melting!"],
      image: "assets/scenes/belly-styled.png",
      imageFallback: "assets/scenes/belly-01.png",
      tint: "rose",
      crop: "left"
    },
    {
      title: "Ribcage Rondo",
      text: "The succubus walks her fingers up your ribs like a piano, then back down in fluttering runs that leave you breathless.",
      captions: ["Tickle scales~", "Up and down the ribs!", "Keep tapping!"],
      image: "assets/scenes/belly-styled.png",
      imageFallback: "assets/scenes/belly-01.png",
      tint: "magenta",
      crop: "right"
    },
    {
      title: "Shirt Lift",
      text: "Your shirt is tugged up just enough. Warm breath and colder fingertips explore the exposed skin until you writhe.",
      captions: ["Just a little lift~", "So soft under there!", "Resist, explorer!"],
      image: "assets/scenes/belly-styled.png",
      imageFallback: "assets/scenes/belly-01.png",
      tint: "violet",
      crop: "top"
    },
    {
      title: "Flank Sandwich",
      text: "Minions attack both sides at once while the succubus watches, chin on hand, thoroughly entertained.",
      captions: ["Left and right~!", "No safe flank!", "Double trouble!"],
      image: "assets/scenes/belly-styled.png",
      imageFallback: "assets/scenes/belly-01.png",
      tint: "warm",
      crop: "bottom"
    }
  ],
  tied: [
    {
      title: "Silk Bind",
      text: "Magical ribbons yank you flat against a stone pillar. Bound at wrists and ankles, you can only thrash as tickles rain everywhere.",
      captions: ["Tied tight~", "Nowhere to run!", "Struggle cutely~"],
      image: "assets/scenes/tied-01.png",
      imageFallback: "assets/scenes/tied-01.png",
      tint: null,
      crop: "center"
    },
    {
      title: "Altar of Giggles",
      text: "You're laid across a glowing rune-carved slab. Pants tugged just so, the whole crew takes turns finding your weakest spots.",
      captions: ["Manor altar special~", "Everyone gets a turn!", "Resist the ritual!"],
      image: "assets/scenes/tied-01.png",
      imageFallback: "assets/scenes/tied-01.png",
      tint: "magenta",
      crop: "left"
    },
    {
      title: "Webbed & Wriggling",
      text: "Sticky spider-silk (succubus special) cocoon-wraps your legs. Helpless, you endure a coordinated tickle assault.",
      captions: ["Caught in the web~", "Wriggle wriggle!", "Freedom takes taps!"],
      image: "assets/scenes/tied-01.png",
      imageFallback: "assets/scenes/tied-01.png",
      tint: "violet",
      crop: "right"
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
