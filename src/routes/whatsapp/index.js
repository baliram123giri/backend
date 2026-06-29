export default async function whatsappRoutes(fastify, options) {
  fastify.post('/api/whatsapp-deliver', async (request, reply) => {
    try {
      const { phoneNumber, countryCode, pdfBase64, nameField } = request.body;

      if (!phoneNumber || !pdfBase64) {
        return reply.status(400).send({ error: 'phoneNumber and pdfBase64 are required' });
      }

      const cleanCode = (countryCode || '+91').replace('+', '');
      const cleanPhone = phoneNumber.replace(/\D/g, '');
      const fullPhoneNumber = `${cleanCode}${cleanPhone}`;

      const pdfBuffer = Buffer.from(pdfBase64, 'base64');
      const name = nameField || 'biodata';

      const token = process.env.WHATSAPP_TOKEN;
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

      if (!token || !phoneNumberId) {
        return reply.send({
          success: true,
          fallback: true,
          message: 'No credentials configured. Using client-side direct link fallback.'
        });
      }

      const mediaFormData = new FormData();
      const pdfBlob = new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' });
      mediaFormData.append('file', pdfBlob, `${name}.pdf`);
      mediaFormData.append('messaging_product', 'whatsapp');
      mediaFormData.append('type', 'application/pdf');

      const mediaUploadRes = await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: mediaFormData,
        }
      );

      if (!mediaUploadRes.ok) {
        const errorText = await mediaUploadRes.text();
        request.log.error('Meta Media Upload Error:', errorText);
        throw new Error(`Meta Media API error: ${mediaUploadRes.status} - ${errorText}`);
      }

      const mediaUploadJson = await mediaUploadRes.json();
      const mediaId = mediaUploadJson.id;

      if (!mediaId) {
        throw new Error('Failed to retrieve Media ID from Meta API response');
      }

      const messagePayload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: fullPhoneNumber,
        type: 'document',
        document: {
          id: mediaId,
          filename: `${name}.pdf`,
          caption: `Here is your requested marriage biodata for ${name}. 🙏`
        }
      };

      const sendMessageRes = await fetch(
        `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(messagePayload),
        }
      );

      if (!sendMessageRes.ok) {
        const errorText = await sendMessageRes.text();
        request.log.error('Meta Send Message Error:', errorText);
        throw new Error(`Meta Send Message API error: ${sendMessageRes.status} - ${errorText}`);
      }

      const sendMessageJson = await sendMessageRes.json();

      return reply.send({
        success: true,
        mode: 'live',
        message: 'Biodata PDF delivered successfully to WhatsApp!',
        recipient: fullPhoneNumber,
        messageId: sendMessageJson.messages?.[0]?.id
      });
    } catch (err) {
      request.log.error('WhatsApp delivery endpoint error:', err);
      return reply.status(500).send({
        error: 'Failed to deliver WhatsApp message',
        details: err.message
      });
    }
  });
}
