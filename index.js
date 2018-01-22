const https = require('https');
//const querystring = require('querystring');
const URL = require('url');
const FormData = require('form-data');
const AWS = require('aws-sdk');
const SES = new AWS.SES();
const S3 = new AWS.S3();

const VERSION = '0.1.0';

const bounce_sender = process.env.BOUNCE_SENDER;
const sender_arn = process.env.SENDER_ARN;
const bucket_name = process.env.BUCKET_NAME;
const redmineURL = process.env.REDMINE_URL;
const redmineKEY = process.env.REDMINE_KEY;
const allow_override = process.env.ALLOW_OVERRIDE;
const unknown_user = process.env.UNKNOWN_USER;
const default_group = process.env.DEFAULT_GROUP;
const no_account_notice = process.env.NO_ACCOUNT_NOTICE;
const no_notification = process.env.NO_NOTIFICATION;
const no_permission_check = process.env.NO_PERMISSION_CHECK;
const project_from_subaddress = process.env.PROJECT_FROM_SUBADDRESS;

function post_form(url, params, headers) {
    if (!headers) headers = {};
    var urlDetails = new URL.parse(url);
    //var post_data = querystring.stringify(params);
    //headers = Object.assign({'Content-Type': 'application/x-www-form-urlencoded'}, headers);
    var post_data = new FormData();
    for (let field in params)
        post_data.append(field, params[field] || '');
    headers = Object.assign(post_data.getHeaders(), headers);
    headers = Object.assign({'Content-Length': post_data.getLengthSync()}, headers);
    console.log("Submitting POST data to",url, post_data);
    
    return new Promise((rok,rfail) => post_data.pipe(https.request({
        protocol: urlDetails.protocol,
        host: urlDetails.host,
        port: urlDetails.port ? urlDetails.port : (urlDetails.protocol == 'https:' ? 443 : 80),
        method: 'POST',
        path: urlDetails.pathname,
        headers: headers,
    }).on('response', res => {
            res.setEncoding('utf8');
            var data = "";
            res.on('data', chunk => {
                console.log("Response data",chunk);
                data += chunk;
            });
            res.on('end', () => {
                if (parseInt(res.statusCode / 100) == 2)
                    return rok(data);
                console.log("Error response from Redmine",res.statusCode, res.statusMessage, data);
                rfail(new Error(res.statusMessage));
            });
        })));
}

exports.handler = (event, context, callback) => {
    if (!bounce_sender) return callback(new Error('Missing required configuration BOUNCE_SENDER'));
    if (!bucket_name) return callback(new Error('Missing required configuration BUCKET_NAME'));
    if (!redmineURL) return callback(new Error('Missing required configuration REDMINE_URL'));
    if (!redmineKEY) return callback(new Error('Missing required configuration REDMINE_KEY'));
    
    console.log("Got an event",event);
    var rec = event.Records[0];
    if (rec.ses) return sesHandler(rec.ses, callback);
    if (rec.Sns) return snsHandler(rec.Sns, callback);
    return callback(new Error('Unsupported message type'));
};

function snsHandler(message, callback) {
    console.log("SNS Message",message);
    var sesRec = JSON.parse(message.Message);
    if (sesRec.mail) return sesHandler(sesRec, callback);
    return callback(new Error("Invalid SNS received from",message.TopicArn,"with subject",message.Subject));
}

function sesHandler(message, callback) {
    console.log("SES data",message);
    if (message.mail.messageId == 'AMAZON_SES_SETUP_NOTIFICATION') // confirm setup
        return callback(null, 'Success');
    // load email text from S3
    return S3.getObject({ Bucket: bucket_name, Key: message.mail.messageId }, (err, data) => {
        if (err) {
            console.log("Failed to load email from S3",err);
            return callback(err);
        }
        message.content = data.Body.toString('utf-8');
        return S3.deleteObject({ Bucket: bucket_name, Key: message.mail.messageId }, (err, data) => {
            if (err) {
                console.log("Failed to delete message data after reading",err);
                return callback(err);
            }
            return bodyHandler(message, callback);
        });
    });
}

function bodyHandler(message, callback) {
    var email = message.content;
    var headers = email.substr(0,email.indexOf("\r\n\r\n"));
    //var body = email.substr(email.indexOf("\r\n\r\n")+4);
    headers = headers.split(/\r\n(?=\S)/);
    
    var url = redmineURL.replace(/\/*$/,'') + '/mail_handler';
    var key = redmineKEY;
    headers = { 'User-Agent': "Redmine SES mail handler/" + VERSION };
    var data = { key: key, email: email + "\r\n",
        allow_override: allow_override,
        unknown_user: unknown_user,
        default_group: default_group,
        no_account_notice: no_account_notice,
        no_notification: no_notification,
        no_permission_check: no_permission_check,
        project_from_subaddress: project_from_subaddress
    };
    
    post_form(url, data, headers)
    .then(res => callback(null, { response: res }))
    .catch(err => {
        if (err.message.match(/Unprocessable Entity/)) {// redmine bounced our user
            var bounceMessage = {
                BounceSender: bounce_sender,
                BounceSenderArn: sender_arn,
                OriginalMessageId: message.mail.messageId,
                Explanation: 'Redmine bounced your message - '+
                    'you probably need to add your sender address to the email address list in your profile, '+
                    'or ask your administrator to allow anonymous posting',
                BouncedRecipientInfoList: [{
                    Recipient: message.mail.source,
                    BounceType: 'ContentRejected',
                }]
            };
            return SES.sendBounce(bounceMessage, (err, data) => {
                if (err)
                    console.log("Error sending bounce",bounceMessage, err);
                return callback(err, { message: "Send bounce response", bounceId: (data ? data.MessageId : null)});
            });
        }
        return callback(err);
    });
}
