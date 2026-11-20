export const ODI_BATTER_RESPONSE_KNOTS: readonly number[] = [0.25, 0.4, 0.55, 0.7, 0.85];
const Z = [0, 0, 0, 0, 0];
export const ODI_BATTER_RESPONSE: Record<"male" | "female", Record<string, readonly number[]>> = {
  male: { dot: Z, "1": Z, "2": Z, "3": Z, "4": Z, "6": Z, wicket: Z },
  female: { dot: Z, "1": Z, "2": Z, "3": Z, "4": Z, "6": Z, wicket: Z },
};
