<?php
// Old WordPress hook: asks the support agent to tag new comments.
$ch = curl_init('https://api.swfte.com/agents/v1/agents/ag_Supp9x/chat/wordpress');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json', 'X-API-Key: ' . getenv('SWFTE_API_KEY')]);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['message' => 'Tag this comment']));
curl_exec($ch);
