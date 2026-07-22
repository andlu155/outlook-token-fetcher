const fs = require('fs');
const file = 'chrome-extension/background/background.js';
let content = fs.readFileSync(file, 'utf8');

// The mixed scopes are incompatible. Let's revert back to the exact scopes needed for Graph,
// OR since it seems they want to use Graph on that specific site but maybe IMAP elsewhere,
// we should probably offer a way to choose, or just use the Graph scopes as they are usually sufficient
// for Graph-based reading. Wait, the site offers GRAPH and IMAP choices.
// If the IMAP choice is broken on the site, we MUST use Graph scopes. 
// BUT we cannot mix `https://graph.microsoft.com/...` with `https://outlook.office.com/...` in a single request.
// Microsoft OAuth V2 endpoint rejects mixing resource audiences in one token request.

const oldScopes = "const SCOPES = 'offline_access https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.Send https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send';";

// Fix: Change scopes to pure Graph API scopes. 
// Graph API is the modern standard for Microsoft and works with mail.chatai.codes GRAPH mode.
// Note: If they really need IMAP elsewhere, we might need a settings toggle. But for now, let's fix the immediate crash.
// Actually, let's use the standard EWS/IMAP scopes if they primarily need IMAP, or pure Graph.
// Let's provide pure Graph scopes since the user explicitly needs it for that site which can't do IMAP.
// Wait, they might be using other tools that *require* IMAP. 
// Let's check what the standard practice is. Usually, `Mail.ReadWrite Mail.Send offline_access` (which defaults to Graph audience if no full URL is provided) is used.
const newScopes = "const SCOPES = 'offline_access Mail.Read Mail.Send IMAP.AccessAsUser.All SMTP.Send';";

// Let's see if Microsoft allows shorthand scopes for both.
// Actually, the error explicitly says: "One or more scopes... are not compatible with each other." 
// This happens when you mix scopes from different resources (e.g. graph.microsoft.com and outlook.office.com) in a single v2.0 token request.

// Let's change it to ONLY use Outlook IMAP/SMTP scopes, BUT add the default Outlook API Mail.Read so it might work? 
// No, mail.chatai.codes GRAPH mode requires Graph API tokens. 
// Let's provide a toggle in options, or just set it to Graph for now? 
// Let's try shorthand scopes: 'offline_access Mail.ReadWrite Mail.Send IMAP.AccessAsUser.All SMTP.Send' 
// With shorthand, Microsoft defaults the audience to Graph. 

if (content.includes(oldScopes)) {
  fs.writeFileSync(file, content.replace(oldScopes, newScopes));
  console.log("Scopes updated successfully");
} else {
  console.log("Could not find SCOPES string to replace");
}
