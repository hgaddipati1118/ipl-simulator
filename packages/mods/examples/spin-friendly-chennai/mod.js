export default defineMod({
  engine: {
    ballProbabilities(ctx, probs) {
      if (ctx.venue.id !== "chepauk" || !ctx.bowler.isSpin) return probs;
      return { ...probs, wicket: probs.wicket * 1.15, dot: probs.dot * 1.08 };
    },
  },
});
