// @summary Nickname pool of 87 plant/tree names for agent identification (codex-rs style)

const NAMES: readonly string[] = [
  "Acacia",
  "Alder",
  "Aloe",
  "Angelica",
  "Anise",
  "Apple",
  "Arnica",
  "Ash",
  "Aspen",
  "Aster",
  "Avocado",
  "Azalea",
  "Bamboo",
  "Basil",
  "Beech",
  "Birch",
  "Bonsai",
  "Borage",
  "Boxwood",
  "Broom",
  "Cactus",
  "Calendula",
  "Camellia",
  "Cedar",
  "Cherry",
  "Chestnut",
  "Chicory",
  "Clover",
  "Coconut",
  "Comfrey",
  "Cypress",
  "Dahlia",
  "Dandelion",
  "Dill",
  "Douglas",
  "Elder",
  "Elm",
  "Eucalyptus",
  "Fennel",
  "Fern",
  "Fig",
  "Fir",
  "Foxglove",
  "Ginger",
  "Ginkgo",
  "Ginseng",
  "Hawthorn",
  "Hazel",
  "Heather",
  "Hemlock",
  "Hibiscus",
  "Holly",
  "Hornbeam",
  "Hyssop",
  "Iris",
  "Jasmine",
  "Juniper",
  "Laurel",
  "Lavender",
  "Lemon",
  "Linden",
  "Locust",
  "Magnolia",
  "Mahogany",
  "Maple",
  "Mint",
  "Mistletoe",
  "Moss",
  "Mulberry",
  "Myrtle",
  "Nettle",
  "Oak",
  "Olive",
  "Oregano",
  "Osage",
  "Peach",
  "Pine",
  "Poplar",
  "Redwood",
  "Rowan",
  "Sage",
  "Spruce",
  "Sycamore",
  "Thyme",
  "Walnut",
  "Willow",
  "Wisteria",
];

export class NicknamePool {
  private available: string[];
  private readonly names: readonly string[];

  constructor(options: { names?: readonly string[] } = {}) {
    this.names = options.names?.length ? options.names : NAMES;
    this.available = this.shuffle([...this.names]);
  }

  /** Reserve a random nickname, resetting the pool when exhausted. */
  reserve(): string {
    if (this.available.length === 0) {
      this.available = this.shuffle([...this.names]);
    }
    return this.available.pop()!;
  }

  private shuffle(arr: string[]): string[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
