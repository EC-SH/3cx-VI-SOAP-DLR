const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// --- Configuration ---
const VI_LOGIN            = process.env.VI_LOGIN;
const VI_PASSWORD         = process.env.VI_PASSWORD;
const THREECX_WEBHOOK_URL = process.env.THREECX_WEBHOOK_URL;
const OUTBOUND_URL        = process.env.OUTBOUND_URL;
const PORT = process.env.PORT || 8080;
// ---------------------

const VI_API_URL = 'https://backoffice.voipinnovations.com/Services/APIService.asmx';

// Helper: ensure E.164 format, handles 10/11-digit US numbers and array inputs
const formatE164 = (num) => {
    if (Array.isArray(num)) num = num[0];
    if (!num) return '';
    num = String(num).trim().replace(/\D/g, '');
    if (num.length === 10) num = '1' + num;
    return '+' + num;
};

/**
 * 1. INBOUND: Sangoma -> 3CX
 * Sangoma POSTs here when an SMS arrives on your DID.
 * Sangoma uses non-standard field names: caller_id_number, destination_number
 */
app.post('/inbound', async (req, res) => {
    try {
        console.log('--- Received Inbound SMS from Sangoma ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));

        const sangomaBody = req.body;

        const fromNumber  = formatE164(sangomaBody.caller_id_number);
        const toNumber    = formatE164(sangomaBody.destination_number);
        const messageText = sangomaBody.text || '';
        const messageId   = sangomaBody.id || `msg-${Date.now()}`;

        if (!fromNumber || !toNumber) {
            console.error('ERROR: Missing caller_id_number or destination_number in Sangoma payload.');
            return res.status(200).send('Missing fields');
        }

        if (!THREECX_WEBHOOK_URL) {
            console.error('ERROR: THREECX_WEBHOOK_URL is not set.');
            return res.status(200).send('Missing 3CX Webhook config');
        }

        // 3CX Generic SMS requires full Telnyx-style nested envelope
        const threeCxPayload = {
            data: {
                id: messageId,
                event_type: "message.received",
                occurred_at: new Date().toISOString(),
                record_type: "event",
                payload: {
                    direction: "inbound",
                    type: "SMS",
                    record_type: "message",
                    received_at: new Date().toISOString(),
                    text: messageText,
                    from: {
                        phone_number: fromNumber,
                        status: "webhook_delivered"
                    },
                    to: [
                        {
                            phone_number: toNumber,
                            status: "webhook_delivered"
                        }
                    ]
                }
            }
        };

        console.log('Sending to 3CX:', JSON.stringify(threeCxPayload, null, 2));

        const cxResponse = await axios.post(THREECX_WEBHOOK_URL, threeCxPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        console.log('3CX Response Status:', cxResponse.status);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error forwarding to 3CX:', error.message);
        res.status(200).send('Error processed');
    }
});

/**
 * 2. OUTBOUND: 3CX -> VoIP Innovations SOAP API (SendSMSWithDLR)
 * 3CX POSTs here when a user sends an SMS from the 3CX app.
 */
app.post('/outbound', async (req, res) => {
    try {
        console.log('--- Received Outbound SMS from 3CX ---');
        console.log('Payload:', JSON.stringify(req.body, null, 2));

        const cxBody = req.body;

        const fromNumber  = formatE164(cxBody.from).replace('+', '');
        const toNumber    = formatE164(cxBody.to).replace('+', '');
        const messageText = cxBody.text || cxBody.body || '';

        if (!fromNumber || !toNumber || !messageText) {
            console.error('ERROR: Missing from, to, or text in 3CX payload.');
            return res.status(400).send('Missing required fields');
        }

        if (!VI_LOGIN || !VI_PASSWORD) {
            console.error('ERROR: VI_LOGIN or VI_PASSWORD not set.');
            return res.status(500).send('Server configuration error');
        }

        const dlrUrl = OUTBOUND_URL ? `${OUTBOUND_URL}/dlr` : '';

        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SendSMSWithDLR xmlns="http://tempuri.org/">
      <login>${VI_LOGIN}</login>
      <password>${VI_PASSWORD}</password>
      <from>${fromNumber}</from>
      <to>${toNumber}</to>
      <message>${messageText}</message>
      <dlrUrl>${dlrUrl}</dlrUrl>
    </SendSMSWithDLR>
  </soap:Body>
</soap:Envelope>`;

        console.log('Sending to VI SOAP API with DLR callback:', dlrUrl);

        const viResponse = await axios.post(VI_API_URL, soapBody, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': 'http://tempuri.org/SendSMSWithDLR'
            }
        });

        console.log('VI API Response Status:', viResponse.status);
        console.log('VI API Response:', viResponse.data);
        res.status(200).send('OK');

    } catch (error) {
        console.error('Error sending via VI SOAP API:', error.message);
        if (error.response) {
            console.error('VI API error response:', error.response.data);
        }
        res.status(500).send('Failed to send SMS');
    }
});

/**
 * 3. DLR CALLBACK: VoIP Innovations -> here
 * VI POSTs here when a message is delivered or fails.
 */
app.post('/dlr', (req, res) => {
    console.log('--- DLR Callback Received ---');
    console.log('Payload:', JSON.stringify(req.body, null, 2));
    // TODO: forward status to 3CX or log to BigQuery as needed
    res.status(200).send('OK');
});

// Health check
app.get('/', (req, res) => res.send('3CX-Sangoma SMS Middleware is running.'));

app.listen(PORT, () => {
    console.log(`Middleware listening on port ${PORT}`);
    console.log(`Inbound:  POST /inbound`);
    console.log(`Outbound: POST /outbound`);
    console.log(`DLR:      POST /dlr`);
});
