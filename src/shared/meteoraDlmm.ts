export interface DlmmPosition {
  pool_address: string;
  position_address: string;
  lower_bin: number;
  upper_bin: number;
  active_bin: number;
  in_range: boolean;
  token_x_mint: string;
  token_y_mint: string;
  fee_x: string;
  fee_y: string;
}

export interface DlmmWalletSnapshot {
  wallet_id: number;
  state: 'pending' | 'unavailable' | 'ready' | 'stale';
  synced_at: string | null;
  positions: Array<DlmmPosition & { pair: string | null }>;
}
