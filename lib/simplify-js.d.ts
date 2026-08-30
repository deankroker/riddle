declare module "simplify-js" {
  interface Pt {
    x: number;
    y: number;
  }
  export default function simplify(points: Pt[], tolerance?: number, highestQuality?: boolean): Pt[];
}
