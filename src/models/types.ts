export type VendorType = 'restaurant' | 'grocery' | 'drinks' | 'retail';
export type VendorStatus = 'pending' | 'approved' | 'rejected';
export type OrderStatus = 'pending' | 'confirmed' | 'preparing' | 'outForDelivery' | 'delivered' | 'completed' | 'cancelled' | 'appealed';
export type EscrowStatus = 'held' | 'released' | 'appealed' | 'refunded';
export type EscrowReleaseStatus = 'pending' | 'released' | 'refunded';

export interface IVendor {
  id: string; ownerId: string; vendorType: VendorType; name: string; description: string;
  logo: string; isVisible: boolean; status: VendorStatus; rating: number;
  totalCompletedOrders: number; completionRate: number; verified: boolean;
  phone: string; email: string; cac?: string; createdAt: Date; updatedAt: Date; allowsPayOnDelivery: boolean;
}
export interface IBranch {
  id: string; vendorId: string; state: string; lga: string; area: string;
  street: string; estimatedDeliveryTime: number; createdAt: Date;
}
export interface IDeliveryZone {
  id: string; branchId: string; state: string; lga: string; area: string; deliveryFee: number;
}
export interface IMenuItem {
  id: string; branchId: string; name: string; description: string; price: number;
  imageUrl: string; isAvailable: boolean; createdAt: Date; updatedAt: Date;
}
export interface IOrderItem { menuItemId: string; name: string; price: number; quantity: number; }
export interface IOrder {
  id: string; userId: string; vendorId: string; branchId: string;
  vendorName: string; vendorLogo: string; branchName: string;
  items: IOrderItem[]; subtotal: number; deliveryFee: number;
  transactionFee: number; totalAmount: number; status: OrderStatus;
  escrowStatus: EscrowStatus; deliveryState: string; deliveryLga: string;
  deliveryArea: string; deliveryStreet: string; appealReason?: string;
  createdAt: Date; updatedAt: Date;
}
export interface IOrderChat {
  id: string; orderId: string; senderId: string; senderName: string; message: string; createdAt: Date;
}
export interface IEscrow {
  id: string; orderId: string; amountHeld: number; commission: number;
  releaseStatus: EscrowReleaseStatus; appealStatus: boolean; releasedAt?: Date; createdAt: Date;
}
export interface IAppConfig {
  id: string; transactionFeePercent: number; autoReleaseHours: number;
  commissionPercent: number; createdAt: Date; updatedAt: Date;
}