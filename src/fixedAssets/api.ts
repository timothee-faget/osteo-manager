import { invoke } from "@tauri-apps/api/core";

export type FixedAssetInput = {
  label: string;
  /** `YYYY-MM-DD` */
  acquired_on: string;
  cost_cents: number;
  duration_years: number;
  /** Sold or scrapped on. */
  disposed_on: string | null;
  disposal_price_cents: number | null;
  notes: string;
};

export type FixedAsset = FixedAssetInput & { id: number };

/** An asset of the register for the year shown. */
export type AssetYear = FixedAsset & {
  annuity_cents: number;
  net_cents: number;
};

export type Register = {
  year: number;
  assets: AssetYear[];
  total_cents: number;
};

/** One year of the depreciation plan. */
export type Annuity = {
  year: number;
  amount_cents: number;
  cumulative_cents: number;
  net_cents: number;
};

export const fixedAssetsApi = {
  register: (year: number) =>
    invoke<Register>("get_fixed_asset_register", { year }),
  schedule: (id: number) =>
    invoke<Annuity[]>("get_fixed_asset_schedule", { id }),
  create: (asset: FixedAssetInput) =>
    invoke<FixedAsset>("create_fixed_asset", { asset }),
  update: (id: number, asset: FixedAssetInput) =>
    invoke<FixedAsset>("update_fixed_asset", { id, asset }),
  delete: (id: number) => invoke<void>("delete_fixed_asset", { id }),
};
