import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Cashfree Payment Gateway Service (API v3 / 2023-08-01)
 * Supports Sandbox (Testing Mode) and Production (Live Mode)
 */

export function getCashfreeConfig() {
  dotenv.config();
  const appId = (process.env.CASHFREE_APP_ID || '').trim();
  const secretKey = (process.env.CASHFREE_SECRET_KEY || '').trim();
  const rawEnv = (process.env.CASHFREE_ENV || 'TEST').toUpperCase().trim();
  const isProduction = rawEnv === 'PRODUCTION' || rawEnv === 'PROD' || rawEnv === 'LIVE';

  const baseUrl = isProduction
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg';

  const isConfigured = Boolean(
    appId &&
    secretKey &&
    !appId.includes('PLACEHOLDER') &&
    !secretKey.includes('PLACEHOLDER')
  );

  return {
    appId,
    secretKey,
    isProduction,
    baseUrl,
    isConfigured,
  };
}

/**
 * Create a new payment order on Cashfree
 */
export async function createCashfreeOrder({
  orderId,
  orderAmount,
  orderCurrency = 'INR',
  customerDetails,
  orderMeta,
  orderNote = 'Biodata Download Order',
}) {
  const config = getCashfreeConfig();

  if (!config.isConfigured) {
    throw new Error('Cashfree credentials (CASHFREE_APP_ID / CASHFREE_SECRET_KEY) are not configured.');
  }

  // Sanitize customer details per Cashfree API specification
  const rawPhone = (customerDetails?.customer_phone || '').replace(/\D/g, '');
  const cleanPhone = rawPhone.length >= 10 ? rawPhone.slice(-10) : '9999999999';
  const cleanEmail = (customerDetails?.customer_email || 'support@biodata99.com').trim();
  const cleanName = (customerDetails?.customer_name || 'Customer').trim().slice(0, 100);
  const cleanCustomerId = (customerDetails?.customer_id || `cust_${Date.now()}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 50);

  const payload = {
    order_id: String(orderId).slice(0, 50),
    order_amount: Number(orderAmount.toFixed(2)),
    order_currency: orderCurrency,
    customer_details: {
      customer_id: cleanCustomerId,
      customer_name: cleanName,
      customer_email: cleanEmail,
      customer_phone: cleanPhone,
    },
    order_meta: {
      return_url: orderMeta?.return_url,
      notify_url: orderMeta?.notify_url,
      payment_methods: 'upi,cc,dc,nb,app',
    },
    order_note: String(orderNote).slice(0, 100),
  };

  const response = await fetch(`${config.baseUrl}/orders`, {
    method: 'POST',
    headers: {
      'x-client-id': config.appId,
      'x-client-secret': config.secretKey,
      'x-api-version': '2023-08-01',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.message || data.error || `Cashfree Order API returned status ${response.status}`;
    console.error('[Cashfree Service] Create Order Error:', { status: response.status, data });
    throw new Error(errorMsg);
  }

  return data;
}

/**
 * Fetch Order details from Cashfree to verify payment status
 */
export async function getCashfreeOrderStatus(orderId) {
  const config = getCashfreeConfig();

  if (!config.isConfigured) {
    throw new Error('Cashfree credentials are not configured.');
  }

  const response = await fetch(`${config.baseUrl}/orders/${encodeURIComponent(orderId)}`, {
    method: 'GET',
    headers: {
      'x-client-id': config.appId,
      'x-client-secret': config.secretKey,
      'x-api-version': '2023-08-01',
      'Accept': 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    const errorMsg = data.message || `Cashfree Query API returned status ${response.status}`;
    console.error('[Cashfree Service] Fetch Order Error:', { status: response.status, data });
    throw new Error(errorMsg);
  }

  return data;
}

/**
 * Fetch Payments list for an order from Cashfree
 */
export async function getCashfreeOrderPayments(orderId) {
  const config = getCashfreeConfig();

  if (!config.isConfigured) {
    return [];
  }

  try {
    const response = await fetch(`${config.baseUrl}/orders/${encodeURIComponent(orderId)}/payments`, {
      method: 'GET',
      headers: {
        'x-client-id': config.appId,
        'x-client-secret': config.secretKey,
        'x-api-version': '2023-08-01',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('[Cashfree Service] getCashfreeOrderPayments error:', err.message);
    return [];
  }
}

/**
 * Verify Cashfree Webhook Signature
 */
export function verifyCashfreeWebhookSignature(signature, rawBody, timestamp) {
  const config = getCashfreeConfig();
  if (!config.secretKey || !signature || !timestamp || !rawBody) {
    return false;
  }

  try {
    const payload = `${timestamp}${rawBody}`;
    const generatedSignature = crypto
      .createHmac('sha256', config.secretKey)
      .update(payload)
      .digest('base64');

    return signature === generatedSignature;
  } catch (err) {
    console.error('[Cashfree Service] Webhook signature verification error:', err);
    return false;
  }
}
