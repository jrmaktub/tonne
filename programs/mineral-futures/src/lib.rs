use anchor_lang::prelude::*;

declare_id!("zqUKe6cBSnMRCSouhMFzXDHdP5ExuhDbmnvqJX8KoSb");

// ─── Constants ──────────────────────────────────────────────────────────────

pub const TAKER_FEE_BPS: u64 = 5; // 0.05% on open AND close
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_LEVERAGE: u8 = 10;
pub const LIQUIDATOR_REWARD_BPS: u64 = 200; // 2% of the position's collateral
pub const FUNDING_INTERVAL: i64 = 28_800; // 8 hours
pub const MAX_FUNDING_RATE_BPS: i64 = 10; // 0.1% per interval
pub const MIN_COLLATERAL: u64 = 10_000_000; // 0.01 SOL
pub const MAX_PRICE_AGE: i64 = 86_400; // 24 hours. Metals reference prices move slowly.

/// Profit only counts for a price move up to this size (30%). Because profit is
/// capped, the most the pot can ever owe is known in advance, and that is what
/// makes the solvency rule below possible.
pub const MAX_MOVE_BPS: u64 = 3_000;

/// A single oracle update may not move the price by more than this (25%).
pub const MAX_UPDATE_DEVIATION_BPS: u64 = 2_500;

/// How many recent prices are kept on-chain for the chart.
pub const HISTORY_LEN: usize = 64;

// ─── Program ────────────────────────────────────────────────────────────────

#[program]
pub mod mineral_futures {
    use super::*;

    /// Creates a market, its shared pot (vault) and its price history.
    /// The authority starts as the oracle too. Hand the oracle role to a
    /// dedicated key with `set_oracle`.
    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        commodity: String,
        initial_price: u64,
    ) -> Result<()> {
        require!(commodity.len() <= 16, FuturesError::CommodityNameTooLong);
        require!(initial_price > 0, FuturesError::InvalidPrice);

        let now = Clock::get()?.unix_timestamp;
        let market = &mut ctx.accounts.market;
        let mut commodity_bytes = [0u8; 16];
        let bytes = commodity.as_bytes();
        commodity_bytes[..bytes.len()].copy_from_slice(bytes);

        market.commodity = commodity_bytes;
        market.mark_price = initial_price;
        market.last_price_update = now;
        market.open_interest_long = 0;
        market.open_interest_short = 0;
        market.total_fees_collected = 0;
        market.authority = ctx.accounts.authority.key();
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        market.funding_rate_cumulative = 0;
        market.last_funding_time = now;
        market.is_paused = false;
        market.oracle = ctx.accounts.authority.key();
        market.notional_long = 0;
        market.notional_short = 0;
        market.max_loss_long = 0;
        market.max_loss_short = 0;

        let history = &mut ctx.accounts.history;
        history.market = market.key();
        history.head = 0;
        history.len = 0;
        push_history(history, now, initial_price);
        Ok(())
    }

    /// Only the oracle key can move the price. Each update is limited in size
    /// and is written to the on-chain price history.
    pub fn update_price(ctx: Context<UpdatePrice>, new_price: u64) -> Result<()> {
        require!(new_price > 0, FuturesError::InvalidPrice);
        let market = &mut ctx.accounts.market;
        require!(
            within_deviation(market.mark_price, new_price),
            FuturesError::PriceJumpTooLarge
        );
        let now = Clock::get()?.unix_timestamp;
        market.mark_price = new_price;
        market.last_price_update = now;
        push_history(&mut ctx.accounts.history, now, new_price);
        Ok(())
    }

    pub fn set_oracle(ctx: Context<SetOracle>) -> Result<()> {
        ctx.accounts.market.oracle = ctx.accounts.new_oracle.key();
        Ok(())
    }

    /// Anyone can add SOL to the market's reserve. The reserve is what lets the
    /// pot honour winners when one side of the book is bigger than the other.
    pub fn fund_reserve(ctx: Context<FundReserve>, amount: u64) -> Result<()> {
        require!(amount > 0, FuturesError::NothingToWithdraw);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.funder.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount,
        )
    }

    pub fn open_position(
        ctx: Context<OpenPosition>,
        direction: u8,
        nonce: i64,
        collateral_lamports: u64,
        leverage: u8,
    ) -> Result<()> {
        // Auto-crank funding (free, no bot needed)
        try_apply_funding(&mut ctx.accounts.market)?;

        require!(!ctx.accounts.market.is_paused, FuturesError::MarketPaused);
        require!(direction <= 1, FuturesError::InvalidDirection);
        require!(collateral_lamports >= MIN_COLLATERAL, FuturesError::CollateralTooSmall);
        require!(leverage >= 1 && leverage <= MAX_LEVERAGE, FuturesError::InvalidLeverage);

        let now = Clock::get()?.unix_timestamp;
        require!(
            now - ctx.accounts.market.last_price_update <= MAX_PRICE_AGE,
            FuturesError::StalePrice
        );

        // Numbers before this trade, for the solvency check at the end.
        let need_before = required_reserve(
            ctx.accounts.market.notional_long,
            ctx.accounts.market.notional_short,
            ctx.accounts.market.max_loss_long,
            ctx.accounts.market.max_loss_short,
        );

        // Collateral goes into the pot.
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            collateral_lamports,
        )?;

        let fee = collateral_lamports
            .checked_mul(TAKER_FEE_BPS).unwrap_or(0)
            .checked_div(BPS_DENOMINATOR).unwrap_or(0);
        let net_collateral = collateral_lamports.saturating_sub(fee);

        if fee > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= fee;
            **ctx.accounts.authority.to_account_info().try_borrow_mut_lamports()? += fee;
        }

        let notional = net_collateral.saturating_mul(leverage as u64);

        let entry_price = ctx.accounts.market.mark_price;
        let entry_funding = ctx.accounts.market.funding_rate_cumulative;

        let position = &mut ctx.accounts.position;
        position.owner = ctx.accounts.trader.key();
        position.market = ctx.accounts.market.key();
        position.direction = direction;
        position.collateral = net_collateral;
        position.entry_price = entry_price;
        position.opened_at = nonce;
        position.fee_paid = fee;
        position.leverage = leverage;
        position.is_open = true;
        position.bump = ctx.bumps.position;
        position.entry_funding_rate = entry_funding;

        let max_loss = max_loss_at_cap(net_collateral, leverage as u64);
        let market = &mut ctx.accounts.market;
        if direction == 0 {
            market.open_interest_long = market.open_interest_long.saturating_add(net_collateral);
            market.notional_long = market.notional_long.saturating_add(notional);
            market.max_loss_long = market.max_loss_long.saturating_add(max_loss);
        } else {
            market.open_interest_short = market.open_interest_short.saturating_add(net_collateral);
            market.notional_short = market.notional_short.saturating_add(notional);
            market.max_loss_short = market.max_loss_short.saturating_add(max_loss);
        }
        market.total_fees_collected = market.total_fees_collected.saturating_add(fee);

        // SOLVENCY RULE. After this trade, the pot's free reserve must cover the
        // worst case the market can now owe. A trade that makes the worst case
        // smaller (it balances the book) is always allowed.
        let need_after = required_reserve(
            market.notional_long,
            market.notional_short,
            market.max_loss_long,
            market.max_loss_short,
        );
        let reserve = free_reserve(
            ctx.accounts.vault.to_account_info().lamports(),
            Rent::get()?.minimum_balance(8),
            market.open_interest_long,
            market.open_interest_short,
        );
        require!(
            need_after <= reserve || need_after <= need_before,
            FuturesError::ReserveTooLow
        );
        Ok(())
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        try_apply_funding(&mut ctx.accounts.market)?;

        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;

        require!(position.is_open, FuturesError::PositionAlreadyClosed);
        require!(position.owner == ctx.accounts.trader.key(), FuturesError::Unauthorized);

        let collateral = position.collateral;
        let leverage = position.leverage as u64;
        let notional = collateral.saturating_mul(leverage);

        let pnl = calc_pnl(position.direction, market.mark_price, position.entry_price, collateral, leverage);
        let funding = calc_funding_payment(
            position.direction, market.funding_rate_cumulative, position.entry_funding_rate, collateral,
        );
        let total_pnl = pnl.saturating_add(funding);

        let raw_payout: u64 = if total_pnl >= 0 {
            collateral.saturating_add(total_pnl as u64)
        } else {
            collateral.saturating_sub(total_pnl.unsigned_abs().min(collateral))
        };

        let close_fee = raw_payout
            .checked_mul(TAKER_FEE_BPS).unwrap_or(0)
            .checked_div(BPS_DENOMINATOR).unwrap_or(0);
        let payout = raw_payout.saturating_sub(close_fee);

        // Safety net only. The solvency rule on open should make this cap
        // unreachable. If it ever binds, the pot was short, so say so loudly.
        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        let rent_min = Rent::get()?.minimum_balance(8);
        let available = vault_balance.saturating_sub(rent_min);
        if payout > available {
            msg!("WARNING: pot short by {} lamports, payout capped", payout - available);
        }
        let actual_payout = payout.min(available);

        if actual_payout > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= actual_payout;
            **ctx.accounts.trader.to_account_info().try_borrow_mut_lamports()? += actual_payout;
        }

        let direction = position.direction;
        let max_loss = max_loss_at_cap(collateral, leverage);
        let market = &mut ctx.accounts.market;
        if direction == 0 {
            market.open_interest_long = market.open_interest_long.saturating_sub(collateral);
            market.notional_long = market.notional_long.saturating_sub(notional);
            market.max_loss_long = market.max_loss_long.saturating_sub(max_loss);
        } else {
            market.open_interest_short = market.open_interest_short.saturating_sub(collateral);
            market.notional_short = market.notional_short.saturating_sub(notional);
            market.max_loss_short = market.max_loss_short.saturating_sub(max_loss);
        }
        market.total_fees_collected = market.total_fees_collected.saturating_add(close_fee);

        ctx.accounts.position.is_open = false;
        Ok(())
    }

    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        try_apply_funding(&mut ctx.accounts.market)?;

        let position = &ctx.accounts.position;
        let market = &ctx.accounts.market;

        require!(position.is_open, FuturesError::PositionAlreadyClosed);

        let collateral = position.collateral;
        let leverage = position.leverage as u64;
        let notional = collateral.saturating_mul(leverage);

        let pnl = calc_pnl(position.direction, market.mark_price, position.entry_price, collateral, leverage);
        let funding = calc_funding_payment(
            position.direction, market.funding_rate_cumulative, position.entry_funding_rate, collateral,
        );
        let total_pnl = pnl.saturating_add(funding);

        let threshold = (collateral as i64)
            .checked_mul(9000).unwrap_or(i64::MAX)
            .checked_div(BPS_DENOMINATOR as i64).unwrap_or(i64::MAX);
        require!(total_pnl <= -threshold, FuturesError::NotLiquidatable);

        let liquidator_reward = collateral
            .checked_mul(LIQUIDATOR_REWARD_BPS).unwrap_or(0)
            .checked_div(BPS_DENOMINATOR).unwrap_or(0);

        let vault_balance = ctx.accounts.vault.to_account_info().lamports();
        let rent_min = Rent::get()?.minimum_balance(8);
        let actual_reward = liquidator_reward.min(vault_balance.saturating_sub(rent_min));

        if actual_reward > 0 {
            **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= actual_reward;
            **ctx.accounts.liquidator.to_account_info().try_borrow_mut_lamports()? += actual_reward;
        }

        let direction = position.direction;
        let max_loss = max_loss_at_cap(collateral, leverage);
        let market = &mut ctx.accounts.market;
        if direction == 0 {
            market.open_interest_long = market.open_interest_long.saturating_sub(collateral);
            market.notional_long = market.notional_long.saturating_sub(notional);
            market.max_loss_long = market.max_loss_long.saturating_sub(max_loss);
        } else {
            market.open_interest_short = market.open_interest_short.saturating_sub(collateral);
            market.notional_short = market.notional_short.saturating_sub(notional);
            market.max_loss_short = market.max_loss_short.saturating_sub(max_loss);
        }

        ctx.accounts.position.is_open = false;
        Ok(())
    }

    /// Manual funding crank (auto-crank on trades handles it too).
    pub fn apply_funding(ctx: Context<ApplyFunding>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;
        require!(now - market.last_funding_time >= FUNDING_INTERVAL, FuturesError::FundingTooEarly);
        do_apply_funding(market, now);
        Ok(())
    }

    pub fn pause_market(ctx: Context<PauseMarket>) -> Result<()> {
        ctx.accounts.market.is_paused = true;
        Ok(())
    }

    pub fn unpause_market(ctx: Context<PauseMarket>) -> Result<()> {
        ctx.accounts.market.is_paused = false;
        Ok(())
    }

    /// The authority can only take out reserve that is not needed to back the
    /// open book. Trader collateral can never be withdrawn this way.
    pub fn withdraw_reserve(ctx: Context<WithdrawReserve>, amount: u64) -> Result<()> {
        let market = &ctx.accounts.market;
        let reserve = free_reserve(
            ctx.accounts.vault.to_account_info().lamports(),
            Rent::get()?.minimum_balance(8),
            market.open_interest_long,
            market.open_interest_short,
        );
        let locked = required_reserve(
            market.notional_long,
            market.notional_short,
            market.max_loss_long,
            market.max_loss_short,
        );
        let withdrawable = reserve.saturating_sub(locked);
        require!(amount > 0 && amount <= withdrawable, FuturesError::NothingToWithdraw);

        **ctx.accounts.vault.to_account_info().try_borrow_mut_lamports()? -= amount;
        **ctx.accounts.authority.to_account_info().try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    pub fn transfer_authority(ctx: Context<TransferAuthority>) -> Result<()> {
        ctx.accounts.market.authority = ctx.accounts.new_authority.key();
        Ok(())
    }

    pub fn close_position_account(_ctx: Context<ClosePositionAccount>) -> Result<()> {
        // Anchor's close constraint handles the lamport transfer
        Ok(())
    }
}

// ─── Pure helpers (unit tested below) ───────────────────────────────────────

/// Is `new` within MAX_UPDATE_DEVIATION_BPS of `old`?
pub fn within_deviation(old: u64, new: u64) -> bool {
    let (old, new) = (old as u128, new as u128);
    let diff = if new > old { new - old } else { old - new };
    diff * BPS_DENOMINATOR as u128 <= old * MAX_UPDATE_DEVIATION_BPS as u128
}

/// Profit or loss of one position. The favourable price move is capped at
/// MAX_MOVE_BPS. The unfavourable move is not capped here: the caller floors
/// the payout at zero.
pub fn calc_pnl(direction: u8, current_price: u64, entry_price: u64, collateral: u64, leverage: u64) -> i64 {
    if entry_price == 0 {
        return 0;
    }
    let cur = current_price as i128;
    let ent = entry_price as i128;
    let diff = if direction == 0 { cur - ent } else { ent - cur };
    let max_gain = ent * MAX_MOVE_BPS as i128 / BPS_DENOMINATOR as i128;
    let diff = diff.min(max_gain);
    let pnl = diff * collateral as i128 * leverage as i128 / ent;
    pnl.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

/// The most one position can lose if the price moves by MAX_MOVE_BPS against
/// it. A low-leverage position loses only part of its collateral. A
/// high-leverage one loses nearly all of it, but never more than the
/// liquidator's cut leaves behind.
pub fn max_loss_at_cap(collateral: u64, leverage: u64) -> u64 {
    let move_loss_bps = (leverage as u128 * MAX_MOVE_BPS as u128)
        .min((BPS_DENOMINATOR - LIQUIDATOR_REWARD_BPS) as u128);
    (collateral as u128 * move_loss_bps / BPS_DENOMINATOR as u128) as u64
}

/// The most the pot can owe beyond the collateral it already holds, over either
/// direction of a MAX_MOVE_BPS price move.
///
/// If the price rises by the maximum, longs win up to `notional_long * move`.
/// Shorts lose, but each short loses at most `max_loss_at_cap`. The gap is what
/// the reserve must cover. The same is done for a fall. Because gains grow in a
/// straight line and losses level off, the worst case is always at the maximum
/// move, so checking that one point is enough.
///
/// Rounding can leave the pot short by at most one lamport per open position.
pub fn required_reserve(
    notional_long: u64,
    notional_short: u64,
    max_loss_long: u64,
    max_loss_short: u64,
) -> u64 {
    let m = MAX_MOVE_BPS as u128;
    let d = BPS_DENOMINATOR as u128;

    let gain_if_up = notional_long as u128 * m / d;
    let gain_if_down = notional_short as u128 * m / d;

    let need = gain_if_up
        .saturating_sub(max_loss_short as u128)
        .max(gain_if_down.saturating_sub(max_loss_long as u128));
    need.min(u64::MAX as u128) as u64
}

/// Lamports in the pot that are not trader collateral and not rent.
pub fn free_reserve(vault_lamports: u64, rent_min: u64, oi_long: u64, oi_short: u64) -> u64 {
    vault_lamports
        .saturating_sub(rent_min)
        .saturating_sub(oi_long)
        .saturating_sub(oi_short)
}

pub fn push_history(h: &mut PriceHistory, ts: i64, price: u64) {
    let i = (h.head as usize) % HISTORY_LEN;
    h.points[i] = PricePoint { ts, price };
    h.head = ((i + 1) % HISTORY_LEN) as u8;
    if (h.len as usize) < HISTORY_LEN {
        h.len += 1;
    }
}

/// Auto-crank: silently applies funding if the interval has passed.
fn try_apply_funding(market: &mut Account<Market>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    if now - market.last_funding_time >= FUNDING_INTERVAL {
        do_apply_funding(market, now);
    }
    Ok(())
}

fn do_apply_funding(market: &mut Account<Market>, now: i64) {
    let oi_long = market.open_interest_long as i64;
    let oi_short = market.open_interest_short as i64;
    let total_oi = oi_long + oi_short;

    let rate: i64 = if total_oi > 0 {
        oi_long.saturating_sub(oi_short)
            .saturating_mul(MAX_FUNDING_RATE_BPS)
            .checked_div(total_oi)
            .unwrap_or(0)
    } else {
        0
    };

    market.funding_rate_cumulative = market.funding_rate_cumulative.saturating_add(rate);
    market.last_funding_time = now;
}

fn calc_funding_payment(direction: u8, cumulative: i64, entry_rate: i64, collateral: u64) -> i64 {
    let delta = cumulative - entry_rate;
    let raw = delta
        .saturating_mul(collateral as i64)
        .checked_div(BPS_DENOMINATOR as i64)
        .unwrap_or(0);
    if direction == 0 { -raw } else { raw }
}

// ─── Accounts ───────────────────────────────────────────────────────────────

// New fields are appended at the end so the first 107 bytes keep their layout.
#[account]
pub struct Market {
    pub commodity: [u8; 16],
    pub mark_price: u64,
    pub last_price_update: i64,
    pub open_interest_long: u64,
    pub open_interest_short: u64,
    pub total_fees_collected: u64,
    pub authority: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    pub funding_rate_cumulative: i64,
    pub last_funding_time: i64,
    pub is_paused: bool,
    pub oracle: Pubkey,
    pub notional_long: u64,
    pub notional_short: u64,
    /// Sum over open longs of the most each one can lose at the maximum move.
    pub max_loss_long: u64,
    /// Same for shorts.
    pub max_loss_short: u64,
}

impl Market {
    pub const SIZE: usize = 8 + 16 + 8 + 8 + 8 + 8 + 8 + 32 + 1 + 1 + 8 + 8 + 1 + 32 + 8 + 8 + 8 + 8;
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub direction: u8,
    pub collateral: u64,
    pub entry_price: u64,
    pub opened_at: i64,
    pub fee_paid: u64,
    pub leverage: u8,
    pub is_open: bool,
    pub bump: u8,
    pub entry_funding_rate: i64,
}

impl Position {
    pub const SIZE: usize = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 8;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct PricePoint {
    pub ts: i64,
    pub price: u64,
}

/// Ring buffer of the most recent oracle prices. Read by the chart.
#[account]
pub struct PriceHistory {
    pub market: Pubkey,
    pub head: u8,
    pub len: u8,
    pub points: [PricePoint; HISTORY_LEN],
}

impl PriceHistory {
    pub const SIZE: usize = 8 + 32 + 1 + 1 + 16 * HISTORY_LEN;
}

#[account]
pub struct VaultAccount {}

// ─── Account Contexts ───────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(commodity: String)]
pub struct InitializeMarket<'info> {
    #[account(
        init, payer = authority, space = Market::SIZE,
        seeds = [b"market", commodity.as_bytes()], bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = authority, space = 8,
        seeds = [b"vault", market.key().as_ref()], bump,
    )]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        init, payer = authority, space = PriceHistory::SIZE,
        seeds = [b"history", market.key().as_ref()], bump,
    )]
    pub history: Box<Account<'info, PriceHistory>>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(mut, has_one = oracle @ FuturesError::Unauthorized)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"history", market.key().as_ref()], bump,
        has_one = market @ FuturesError::InvalidMarket,
    )]
    pub history: Box<Account<'info, PriceHistory>>,
    pub oracle: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetOracle<'info> {
    #[account(mut, has_one = authority @ FuturesError::Unauthorized)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
    /// CHECK: New oracle key
    pub new_oracle: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct FundReserve<'info> {
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut)]
    pub funder: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(direction: u8, nonce: i64, collateral_lamports: u64, leverage: u8)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        init, payer = trader, space = Position::SIZE,
        seeds = [b"position", trader.key().as_ref(), market.key().as_ref(), &nonce.to_le_bytes()],
        bump,
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, VaultAccount>,
    /// CHECK: Market authority / fee collector
    #[account(mut, constraint = authority.key() == market.authority @ FuturesError::Unauthorized)]
    pub authority: AccountInfo<'info>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", trader.key().as_ref(), market.key().as_ref(), &position.opened_at.to_le_bytes()],
        bump = position.bump,
        has_one = market @ FuturesError::InvalidMarket,
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut)]
    pub trader: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", position.owner.as_ref(), market.key().as_ref(), &position.opened_at.to_le_bytes()],
        bump = position.bump,
        has_one = market @ FuturesError::InvalidMarket,
    )]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut)]
    pub liquidator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyFunding<'info> {
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct PauseMarket<'info> {
    #[account(mut, has_one = authority @ FuturesError::Unauthorized)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawReserve<'info> {
    #[account(has_one = authority @ FuturesError::Unauthorized)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAuthority<'info> {
    #[account(mut, has_one = authority @ FuturesError::Unauthorized)]
    pub market: Account<'info, Market>,
    pub authority: Signer<'info>,
    /// CHECK: New authority
    pub new_authority: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ClosePositionAccount<'info> {
    #[account(
        mut, close = owner,
        constraint = !position.is_open @ FuturesError::PositionStillOpen,
        constraint = position.owner == owner.key() @ FuturesError::Unauthorized,
    )]
    pub position: Account<'info, Position>,
    /// CHECK: Original position owner
    #[account(mut)]
    pub owner: AccountInfo<'info>,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

#[error_code]
pub enum FuturesError {
    #[msg("Invalid price")]
    InvalidPrice,
    #[msg("Invalid direction")]
    InvalidDirection,
    #[msg("Name too long")]
    CommodityNameTooLong,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Already closed")]
    PositionAlreadyClosed,
    #[msg("Not liquidatable")]
    NotLiquidatable,
    #[msg("Wrong market")]
    InvalidMarket,
    #[msg("Too small")]
    CollateralTooSmall,
    #[msg("Bad leverage")]
    InvalidLeverage,
    #[msg("Paused")]
    MarketPaused,
    #[msg("Too early")]
    FundingTooEarly,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Stale price")]
    StalePrice,
    #[msg("Still open")]
    PositionStillOpen,
    #[msg("Price update moves the price too far")]
    PriceJumpTooLarge,
    #[msg("Market reserve too low for this trade")]
    ReserveTooLow,
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;

    #[test]
    fn pnl_long_and_short_are_mirror_images() {
        // +10% move, 1 SOL, 1x
        assert_eq!(calc_pnl(0, 110, 100, SOL, 1), (SOL / 10) as i64);
        assert_eq!(calc_pnl(1, 90, 100, SOL, 1), (SOL / 10) as i64);
        assert_eq!(calc_pnl(0, 90, 100, SOL, 1), -((SOL / 10) as i64));
    }

    #[test]
    fn pnl_profit_is_capped_at_the_max_move() {
        // A 100% move pays the same as a 30% move.
        assert_eq!(calc_pnl(0, 200, 100, SOL, 1), calc_pnl(0, 130, 100, SOL, 1));
        assert_eq!(calc_pnl(0, 130, 100, SOL, 10), (SOL * 3) as i64);
    }

    #[test]
    fn pnl_losses_are_not_capped() {
        assert!(calc_pnl(0, 10, 100, SOL, 10) < -(SOL as i64));
    }

    #[test]
    fn deviation_guard() {
        assert!(within_deviation(100, 125));
        assert!(within_deviation(100, 75));
        assert!(!within_deviation(100, 126));
        assert!(!within_deviation(100, 74));
    }

    #[test]
    fn empty_book_needs_no_reserve() {
        assert_eq!(required_reserve(0, 0, 0, 0), 0);
    }

    #[test]
    fn one_sided_book_needs_reserve() {
        // One long, 1 SOL at 1x, nobody else. Price +30% makes it owed 0.3 SOL.
        assert_eq!(required_reserve(SOL, 0, max_loss_at_cap(SOL, 1), 0), SOL * 3 / 10);
    }

    #[test]
    fn balanced_one_x_book_needs_no_reserve() {
        let l = max_loss_at_cap(SOL, 1);
        assert_eq!(required_reserve(SOL, SOL, l, l), 0);
    }

    #[test]
    fn balanced_high_leverage_book_still_needs_reserve() {
        // Losers can only lose their collateral, so 10x needs a cushion.
        let l = max_loss_at_cap(SOL, 10);
        assert!(required_reserve(10 * SOL, 10 * SOL, l, l) > 0);
    }

    #[test]
    fn max_loss_levels_off_for_high_leverage() {
        assert_eq!(max_loss_at_cap(SOL, 1), SOL * 3 / 10);
        assert_eq!(max_loss_at_cap(SOL, 3), SOL * 9 / 10);
        // 10x would be 300% of collateral. It is limited to what stays in the pot.
        assert_eq!(max_loss_at_cap(SOL, 10), SOL * 98 / 100);
    }

    #[test]
    fn free_reserve_excludes_collateral_and_rent() {
        assert_eq!(free_reserve(10, 2, 3, 4), 1);
        assert_eq!(free_reserve(1, 2, 3, 4), 0);
    }

    #[test]
    fn history_ring_wraps_and_counts() {
        let mut h = PriceHistory {
            market: Pubkey::default(),
            head: 0,
            len: 0,
            points: [PricePoint { ts: 0, price: 0 }; HISTORY_LEN],
        };
        for i in 0..(HISTORY_LEN as u64 + 5) {
            push_history(&mut h, i as i64, 1000 + i);
        }
        assert_eq!(h.len as usize, HISTORY_LEN);
        assert_eq!(h.head as usize, 5);
        // Newest point sits just behind head, oldest sits at head.
        assert_eq!(h.points[4].price, 1000 + HISTORY_LEN as u64 + 4);
        assert_eq!(h.points[5].price, 1000 + 5);
    }

    /// Tiny deterministic random number generator so the test needs no crates.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn below(&mut self, n: u64) -> u64 { self.next() % n }
    }

    struct Pos { dir: u8, col: u64, entry: u64, lev: u64 }

    /// Property test. Open random positions under the solvency rule, move the
    /// price by any amount, close everyone. The pot must never pay out more
    /// than it holds. This is the guarantee the old program did not have.
    #[test]
    fn solvency_rule_means_the_pot_can_always_pay() {
        let mut rng = Lcg(42);
        for _round in 0..400 {
            let seed = rng.below(5) * SOL / 2; // 0 to 2 SOL of reserve
            let mut pot: u64 = seed;
            let (mut oi_l, mut oi_s, mut n_l, mut n_s) = (0u64, 0u64, 0u64, 0u64);
            let (mut ml_l, mut ml_s) = (0u64, 0u64);
            let mut book: Vec<Pos> = vec![];
            let entry = 1_000 + rng.below(9_000);

            for _ in 0..(1 + rng.below(25)) {
                let dir = rng.below(2) as u8;
                let col = (1 + rng.below(40)) * SOL / 20;
                let lev = 1 + rng.below(MAX_LEVERAGE as u64);
                let before = required_reserve(n_l, n_s, ml_l, ml_s);
                let (mut a, mut b, mut c, mut d) = (oi_l, oi_s, n_l, n_s);
                let (mut e, mut f) = (ml_l, ml_s);
                let ml = max_loss_at_cap(col, lev);
                if dir == 0 { a += col; c += col * lev; e += ml; } else { b += col; d += col * lev; f += ml; }
                let after = required_reserve(c, d, e, f);
                let reserve = (pot + col).saturating_sub(a).saturating_sub(b);
                if after <= reserve || after <= before {
                    pot += col;
                    oi_l = a; oi_s = b; n_l = c; n_s = d; ml_l = e; ml_s = f;
                    book.push(Pos { dir, col, entry, lev });
                }
            }

            // Any price, including moves far beyond the cap.
            let exit = 1 + rng.below(entry * 3);
            let mut paid: u64 = 0;
            for p in &book {
                let pnl = calc_pnl(p.dir, exit, p.entry, p.col, p.lev);
                let raw = if pnl >= 0 { p.col + pnl as u64 } else { p.col.saturating_sub(pnl.unsigned_abs().min(p.col)) };
                paid += raw;
            }
            // Rounding can cost at most one lamport per position.
            assert!(
                paid <= pot + book.len() as u64,
                "pot {} could not pay {} (exit {} entry {})", pot, paid, exit, entry
            );
        }
    }
}
