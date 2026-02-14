export interface CalculationInput {
  productAmount: number;
  rewardBalance: number;
  walletBalance: number;
  useReward: boolean;
  isRecharge: boolean;
  bonusPercent: number; // e.g 0.02
}

export interface CalculationResult {
  walletToDeduct: number;
  rewardToDeduct: number;
  rewardToAdd: number;
  finalRewardBalance: number;
  finalWalletBalance: number;
}

export function calculateTransaction({
  productAmount,
  rewardBalance,
  walletBalance,
  useReward,
  isRecharge,
  bonusPercent,
}: CalculationInput): CalculationResult {

  if (productAmount <= 0) {
    throw new Error("Invalid amount");
  }

  if (rewardBalance < 0 || walletBalance < 0) {
    throw new Error("Invalid balances");
  }

  // 1️⃣ Calculate bonus
  const rawBonus = productAmount * bonusPercent;
  const bonus = Math.min(rawBonus, productAmount);

  // 2️⃣ Determine payable amount
  const payableAmount = isRecharge
    ? productAmount - bonus
    : productAmount;

  // 3️⃣ Apply reward if toggled
  let rewardToDeduct = 0;

  if (useReward) {
    rewardToDeduct = Math.min(rewardBalance, payableAmount);
  }

  const walletToDeduct = payableAmount - rewardToDeduct;

  if (walletToDeduct > walletBalance) {
    throw new Error("Insufficient wallet balance");
  }

  // 4️⃣ Determine reward earned
  const rewardToAdd = isRecharge ? 0 : bonus;

  const finalRewardBalance =
    rewardBalance - rewardToDeduct + rewardToAdd;

  const finalWalletBalance =
    walletBalance - walletToDeduct;

  return {
    walletToDeduct,
    rewardToDeduct,
    rewardToAdd,
    finalRewardBalance,
    finalWalletBalance,
  };
}