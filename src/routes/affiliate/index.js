import { prisma } from '../../lib/prisma.js';
import { hashPassword, verifyPassword, signSession, verifySession } from '../../lib/auth.js';

// Middleware to authenticate affiliate
async function affiliateAuth(request, reply) {
  const auth = request.headers['x-affiliate-token'];
  if (!auth) {
    reply.status(401).send({ error: 'Unauthorized: No token provided' });
    throw new Error('Unauthorized');
  }

  const session = verifySession(auth);
  if (!session || !session.affiliateId) {
    reply.status(401).send({ error: 'Unauthorized: Invalid token' });
    throw new Error('Unauthorized');
  }

  const affiliate = await prisma.affiliate.findUnique({
    where: { id: session.affiliateId }
  });

  if (!affiliate) {
    reply.status(401).send({ error: 'Unauthorized: Affiliate not found' });
    throw new Error('Unauthorized');
  }

  if (affiliate.status === 'suspended') {
    reply.status(403).send({ error: 'Forbidden: Account suspended' });
    throw new Error('Suspended');
  }

  request.affiliate = affiliate;
}

export default async function affiliateRoutes(app, options) {
  
  // -------------------------------------------------------------
  // 1. POST /api/affiliate/signup
  // -------------------------------------------------------------
  app.post('/signup', {
    schema: {
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 2 },
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 6 },
          channelType: { type: 'string' },
          channelUrl: { type: 'string' },
          upiId: { type: 'string' },
          bankAccountName: { type: 'string' },
          bankAccountNumber: { type: 'string' },
          bankIfsc: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { 
        name, email, password, channelType, channelUrl, 
        upiId, bankAccountName, bankAccountNumber, bankIfsc 
      } = request.body;

      // Check if email already exists
      const existing = await prisma.affiliate.findUnique({
        where: { email: email.toLowerCase().trim() }
      });
      if (existing) {
        return reply.status(400).send({ error: 'An account with this email already exists' });
      }

      // Generate a unique referral code: BG + 4-digit number
      let isCodeUnique = false;
      let code = '';
      let attempts = 0;
      while (!isCodeUnique && attempts < 10) {
        const randNum = Math.floor(1000 + Math.random() * 9000);
        code = `BG${randNum}`;
        const existingCode = await prisma.affiliate.findUnique({
          where: { code }
        });
        if (!existingCode) {
          isCodeUnique = true;
        }
        attempts++;
      }

      if (!isCodeUnique) {
        code = `BG${Date.now().toString().slice(-4)}`;
      }

      const hashedPassword = hashPassword(password);

      const affiliate = await prisma.affiliate.create({
        data: {
          name,
          email: email.toLowerCase().trim(),
          password: hashedPassword,
          code,
          channelType,
          channelUrl,
          upiId,
          bankAccountName,
          bankAccountNumber,
          bankIfsc,
          status: 'pending' // manual approval required
        }
      });

      // Sign session token
      const token = signSession({ affiliateId: affiliate.id, email: affiliate.email });

      return {
        success: true,
        message: 'Affiliate registered successfully. Application is pending review.',
        token,
        affiliate: {
          id: affiliate.id,
          name: affiliate.name,
          email: affiliate.email,
          code: affiliate.code,
          status: affiliate.status
        }
      };

    } catch (error) {
      app.log.error('Affiliate Signup Error:', error);
      reply.status(500).send({ error: 'Failed to complete signup', details: error.message });
    }
  });

  // -------------------------------------------------------------
  // 2. POST /api/affiliate/login
  // -------------------------------------------------------------
  app.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { email, password } = request.body;

      const affiliate = await prisma.affiliate.findUnique({
        where: { email: email.toLowerCase().trim() }
      });

      if (!affiliate) {
        return reply.status(400).send({ error: 'Invalid email or password' });
      }

      if (affiliate.status === 'suspended') {
        return reply.status(403).send({ error: 'Your affiliate account has been suspended. Please contact support.' });
      }

      const isPasswordValid = verifyPassword(password, affiliate.password);
      if (!isPasswordValid) {
        return reply.status(400).send({ error: 'Invalid email or password' });
      }

      const token = signSession({ affiliateId: affiliate.id, email: affiliate.email });

      return {
        success: true,
        token,
        affiliate: {
          id: affiliate.id,
          name: affiliate.name,
          email: affiliate.email,
          code: affiliate.code,
          status: affiliate.status
        }
      };

    } catch (error) {
      app.log.error('Affiliate Login Error:', error);
      reply.status(500).send({ error: 'Failed to complete login', details: error.message });
    }
  });

  // -------------------------------------------------------------
  // 3. GET /api/affiliate/me
  // -------------------------------------------------------------
  app.get('/me', { preHandler: affiliateAuth }, async (request, reply) => {
    const aff = request.affiliate;
    return {
      success: true,
      affiliate: {
        id: aff.id,
        name: aff.name,
        email: aff.email,
        code: aff.code,
        status: aff.status,
        adminNotes: aff.adminNotes,
        channelType: aff.channelType,
        channelUrl: aff.channelUrl,
        upiId: aff.upiId,
        bankAccountName: aff.bankAccountName,
        bankAccountNumber: aff.bankAccountNumber,
        bankIfsc: aff.bankIfsc,
        createdAt: aff.createdAt
      }
    };
  });

  // -------------------------------------------------------------
  // 4. POST /api/affiliate/track-click (Public click tracking)
  // -------------------------------------------------------------
  app.post('/track-click', {
    schema: {
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string' },
          cookieId: { type: 'string' },
          localStorageId: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { code, cookieId, localStorageId } = request.body;

      const affiliate = await prisma.affiliate.findFirst({
        where: { 
          code: code.trim().toUpperCase(),
          status: 'approved' // must be approved to track clicks
        }
      });

      if (!affiliate) {
        return reply.status(404).send({ error: 'Invalid or unapproved referral code' });
      }

      const ipAddress = request.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
                        request.headers['x-real-ip'] || 
                        request.ip || 
                        null;
      const userAgent = request.headers['user-agent'] || null;

      // Determine uniqueness: check if same IP, cookieId, or localStorageId clicked this affiliate's link in last 24 hours
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const duplicateClick = await prisma.referralClick.findFirst({
        where: {
          affiliateId: affiliate.id,
          createdAt: { gte: oneDayAgo },
          OR: [
            ipAddress ? { ipAddress } : null,
            cookieId ? { cookieId } : null,
            localStorageId ? { localStorageId } : null
          ].filter(Boolean)
        }
      });

      const isUnique = !duplicateClick;

      // Log click in database
      await prisma.referralClick.create({
        data: {
          affiliateId: affiliate.id,
          code: affiliate.code,
          ipAddress,
          userAgent,
          cookieId: cookieId || null,
          localStorageId: localStorageId || null
        }
      });

      // Update counters on Affiliate profile
      await prisma.affiliate.update({
        where: { id: affiliate.id },
        data: {
          totalClicks: { increment: 1 },
          uniqueVisitors: isUnique ? { increment: 1 } : undefined
        }
      });

      return {
        success: true,
        message: 'Click tracked successfully',
        isUnique
      };

    } catch (error) {
      app.log.error('Affiliate Track Click Error:', error);
      reply.status(500).send({ error: 'Failed to track click', details: error.message });
    }
  });

  // -------------------------------------------------------------
  // 5. GET /api/affiliate/dashboard (Dashboard data)
  // -------------------------------------------------------------
  app.get('/dashboard', { preHandler: affiliateAuth }, async (request, reply) => {
    try {
      const affiliate = request.affiliate;

      // Fetch all clicks, commissions, and withdrawals
      const [commissions, withdrawals] = await Promise.all([
        prisma.commission.findMany({
          where: { affiliateId: affiliate.id },
          orderBy: { createdAt: 'desc' }
        }),
        prisma.withdrawal.findMany({
          where: { affiliateId: affiliate.id },
          orderBy: { createdAt: 'desc' }
        })
      ]);

      // Calculate aggregated metrics
      const totalClicks = affiliate.totalClicks;
      const uniqueVisitors = affiliate.uniqueVisitors;
      const premiumPurchases = commissions.filter(c => c.status !== 'rejected').length;

      const pendingCommission = commissions
        .filter(c => c.status === 'pending')
        .reduce((sum, c) => sum + c.commissionAmount, 0);

      const approvedCommission = commissions
        .filter(c => c.status === 'approved')
        .reduce((sum, c) => sum + c.commissionAmount, 0);

      const paidCommission = commissions
        .filter(c => c.status === 'paid')
        .reduce((sum, c) => sum + c.commissionAmount, 0);

      return {
        success: true,
        metrics: {
          totalClicks,
          uniqueVisitors,
          premiumPurchases,
          pendingCommission: parseFloat(pendingCommission.toFixed(2)),
          approvedCommission: parseFloat(approvedCommission.toFixed(2)),
          paidCommission: parseFloat(paidCommission.toFixed(2)),
          referralLink: `https://biodata99.com?ref=${affiliate.code}`,
          referralCode: affiliate.code,
          minWithdrawal: 500
        },
        commissions: commissions.map(c => ({
          id: c.id,
          orderId: c.orderId,
          orderAmount: c.orderAmount,
          commissionAmount: c.commissionAmount,
          status: c.status,
          createdAt: c.createdAt
        })),
        withdrawals: withdrawals.map(w => ({
          id: w.id,
          amount: w.amount,
          status: w.status,
          paymentMethod: w.paymentMethod,
          paymentDetails: w.paymentDetails,
          notes: w.notes,
          paidAt: w.paidAt,
          createdAt: w.createdAt
        }))
      };

    } catch (error) {
      app.log.error('Affiliate Dashboard Error:', error);
      reply.status(500).send({ error: 'Failed to load dashboard data', details: error.message });
    }
  });

  // -------------------------------------------------------------
  // 6. POST /api/affiliate/withdraw (Request Payout)
  // -------------------------------------------------------------
  app.post('/withdraw', {
    preHandler: affiliateAuth,
    schema: {
      body: {
        type: 'object',
        required: ['paymentMethod', 'paymentDetails'],
        properties: {
          paymentMethod: { type: 'string', enum: ['UPI', 'Bank Transfer'] },
          paymentDetails: { type: 'string', minLength: 5 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const affiliate = request.affiliate;
      const { paymentMethod, paymentDetails } = request.body;

      if (affiliate.status !== 'approved') {
        return reply.status(400).send({ error: 'Your affiliate application must be approved before requesting payouts.' });
      }

      // Check if there is already a pending withdrawal request
      const pendingWithdrawal = await prisma.withdrawal.findFirst({
        where: {
          affiliateId: affiliate.id,
          status: 'pending'
        }
      });

      if (pendingWithdrawal) {
        return reply.status(400).send({ error: 'You already have a pending withdrawal request. Please wait for it to be processed.' });
      }

      // Calculate total approved commissions that are NOT linked to any withdrawal request yet
      const approvedCommissions = await prisma.commission.findMany({
        where: {
          affiliateId: affiliate.id,
          status: 'approved',
          withdrawalId: null
        }
      });

      const totalApprovedAmount = approvedCommissions.reduce((sum, c) => sum + c.commissionAmount, 0);

      if (totalApprovedAmount < 500) {
        return reply.status(400).send({ 
          error: `Minimum withdrawal amount is ₹500. Your current approved commissions sum to ₹${totalApprovedAmount.toFixed(2)}.` 
        });
      }

      // Create withdrawal request and link all these approved commissions to it
      const withdrawal = await prisma.withdrawal.create({
        data: {
          affiliateId: affiliate.id,
          amount: parseFloat(totalApprovedAmount.toFixed(2)),
          status: 'pending',
          paymentMethod,
          paymentDetails,
        }
      });

      // Update the commissions with the withdrawalId
      await prisma.commission.updateMany({
        where: {
          id: { in: approvedCommissions.map(c => c.id) }
        },
        data: {
          withdrawalId: withdrawal.id
        }
      });

      return {
        success: true,
        message: `Withdrawal request for ₹${totalApprovedAmount.toFixed(2)} submitted successfully.`,
        withdrawal: {
          id: withdrawal.id,
          amount: withdrawal.amount,
          status: withdrawal.status,
          createdAt: withdrawal.createdAt
        }
      };

    } catch (error) {
      app.log.error('Affiliate Withdrawal Error:', error);
      reply.status(500).send({ error: 'Failed to process withdrawal request', details: error.message });
    }
  });

  // -------------------------------------------------------------
  // 7. POST /api/affiliate/forgot-password
  //    Generates a reset token, stores it on the Affiliate record,
  //    and sends a reset-link email. Always returns a generic 200
  //    response to prevent email enumeration.
  // -------------------------------------------------------------
  app.post('/forgot-password', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    const genericOk = {
      success: true,
      message: 'If that email is registered, a reset link has been sent.'
    };

    try {
      const { email } = request.body;
      const normalizedEmail = email.toLowerCase().trim();

      const affiliate = await prisma.affiliate.findUnique({
        where: { email: normalizedEmail }
      });

      // Return generic OK even if not found (prevent enumeration)
      if (!affiliate) return genericOk;

      // Generate a secure 32-byte hex token (64 chars)
      const { randomBytes } = await import('crypto');
      const token = randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await prisma.affiliate.update({
        where: { id: affiliate.id },
        data: {
          passwordResetToken: token,
          passwordResetExpiry: expiry
        }
      });

      // Build reset URL — use FRONTEND_URL env or default
      const frontendUrl = process.env.FRONTEND_URL || 'https://biodata99.com';
      const resetUrl = `${frontendUrl}/affiliate/reset-password?token=${token}`;

      // Send email via SMTP
      const smtpPass = process.env.EMAIL_PASS;
      if (!smtpPass) {
        app.log.warn('EMAIL_PASS not set — skipping affiliate reset email');
        return genericOk;
      }

      const nodemailer = (await import('nodemailer')).default;
      const smtpHost = process.env.EMAIL_HOST || 'smtp.hostinger.com';
      const smtpPort = parseInt(process.env.EMAIL_PORT || '465');
      const smtpUser = process.env.EMAIL_USER || 'support@biodata99.com';

      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpPort === 465,
        auth: { user: smtpUser, pass: smtpPass },
        tls: { rejectUnauthorized: false }
      });

      await transporter.sendMail({
        from: `"Biodata99 Affiliate" <${smtpUser}>`,
        to: affiliate.email,
        subject: 'Reset Your Affiliate Account Password',
        html: `
          <div style="font-family:'Inter',sans-serif;background-color:#fdf8f4;padding:30px;border-radius:12px;border:1px solid #C9A84C;max-width:600px;margin:0 auto;color:#333333;">
            <div style="text-align:center;margin-bottom:20px;">
              <h1 style="color:#9B1B30;margin:0;font-size:26px;">biodata99.com</h1>
              <p style="color:#C9A84C;margin:4px 0 0;font-size:12px;letter-spacing:1px;font-weight:bold;text-transform:uppercase;">Affiliate Partner Program</p>
            </div>
            <p style="font-size:15px;line-height:1.7;">Hi <strong>${affiliate.name}</strong>,</p>
            <p style="font-size:15px;line-height:1.7;">We received a request to reset your affiliate account password. Click the button below to set a new password. This link is valid for <strong>15 minutes</strong>.</p>
            <div style="text-align:center;margin:30px 0;">
              <a href="${resetUrl}" style="background-color:#9B1B30;color:#ffffff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block;">
                Reset Password
              </a>
            </div>
            <p style="font-size:13px;color:#888888;line-height:1.6;">If you did not request this, please ignore this email. Your password will remain unchanged.</p>
            <p style="font-size:12px;color:#aaaaaa;text-align:center;margin-top:25px;border-top:1px solid #eeeeee;padding-top:15px;">
              This is an automated email from biodata99.com. Please do not reply.
            </p>
          </div>
        `
      });

      return genericOk;

    } catch (error) {
      app.log.error('Affiliate Forgot Password Error:', error);
      // Still return generic OK to prevent enumeration, but log internally
      return genericOk;
    }
  });

  // -------------------------------------------------------------
  // 8. POST /api/affiliate/reset-password
  //    Validates the token, checks expiry, hashes and saves new password.
  // -------------------------------------------------------------
  app.post('/reset-password', {
    schema: {
      body: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token: { type: 'string', minLength: 64, maxLength: 64 },
          password: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { token, password } = request.body;

      const affiliate = await prisma.affiliate.findFirst({
        where: { passwordResetToken: token }
      });

      if (!affiliate) {
        return reply.status(400).send({ error: 'Invalid or expired reset link. Please request a new one.' });
      }

      if (!affiliate.passwordResetExpiry || new Date() > affiliate.passwordResetExpiry) {
        // Invalidate expired token
        await prisma.affiliate.update({
          where: { id: affiliate.id },
          data: { passwordResetToken: null, passwordResetExpiry: null }
        });
        return reply.status(400).send({ error: 'This reset link has expired. Please request a new one.' });
      }

      const hashedPassword = hashPassword(password);

      await prisma.affiliate.update({
        where: { id: affiliate.id },
        data: {
          password: hashedPassword,
          passwordResetToken: null,      // invalidate after use
          passwordResetExpiry: null
        }
      });

      return {
        success: true,
        message: 'Password reset successfully. You can now log in with your new password.'
      };

    } catch (error) {
      app.log.error('Affiliate Reset Password Error:', error);
      reply.status(500).send({ error: 'Failed to reset password. Please try again.' });
    }
  });

  // -------------------------------------------------------------
  // 9. PUT /api/affiliate/payout-settings
  //    Allows an affiliate to add or update their UPI / bank details
  //    at any time after signup (no payment info required at registration).
  // -------------------------------------------------------------
  app.put('/payout-settings', {
    preHandler: affiliateAuth,
    schema: {
      body: {
        type: 'object',
        properties: {
          upiId:             { type: 'string' },
          bankAccountName:   { type: 'string' },
          bankAccountNumber: { type: 'string' },
          bankIfsc:          { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const affiliate = request.affiliate;
      const { upiId, bankAccountName, bankAccountNumber, bankIfsc } = request.body;

      const hasUpi  = upiId && upiId.trim().length > 0;
      const hasBank = bankAccountName && bankAccountNumber && bankIfsc;

      if (!hasUpi && !hasBank) {
        return reply.status(400).send({
          error: 'Please provide either a UPI ID or complete bank account details (name, account number, IFSC).'
        });
      }

      if (hasUpi && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId.trim())) {
        return reply.status(400).send({ error: 'Invalid UPI ID format (e.g. name@upi or 9876543210@paytm).' });
      }

      if (hasBank) {
        if (!/^\d{9,18}$/.test(bankAccountNumber.trim())) {
          return reply.status(400).send({ error: 'Account number must be 9–18 digits.' });
        }
        if (!/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(bankIfsc.trim())) {
          return reply.status(400).send({ error: 'Invalid IFSC code format (e.g. HDFC0000104).' });
        }
        if (bankAccountName.trim().length < 3) {
          return reply.status(400).send({ error: 'Account holder name must be at least 3 characters.' });
        }
      }

      // Clear the other method's fields when switching
      const updateData = hasUpi
        ? { upiId: upiId.trim(), bankAccountName: null, bankAccountNumber: null, bankIfsc: null }
        : { upiId: null, bankAccountName: bankAccountName.trim(), bankAccountNumber: bankAccountNumber.trim(), bankIfsc: bankIfsc.trim().toUpperCase() };

      await prisma.affiliate.update({ where: { id: affiliate.id }, data: updateData });

      return {
        success: true,
        message: `Payout ${hasUpi ? 'UPI ID' : 'bank account'} saved successfully.`
      };

    } catch (error) {
      app.log.error('Affiliate Payout Settings Error:', error);
      reply.status(500).send({ error: 'Failed to save payout settings. Please try again.' });
    }
  });

}
