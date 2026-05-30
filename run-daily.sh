#!/bin/zsh
# Daily CT digest (local fallback): fetch tweets, summarize via Anthropic API,
# send to Telegram. The cloud version (GitHub Actions) is now the primary path;
# this stays as a manual on-demand run. Uses absolute paths + reads .env.

DIR=/Users/basimnadeem/Desktop/ct-newsletter
NODE=/opt/homebrew/bin/node
LOG=$DIR/run.log

cd $DIR || exit 1
set -a; . ./.env; set +a

echo "===== $(date) START =====" >> $LOG

# 1) Fetch + clean
$NODE fetch.mjs > tweets.json 2>> $LOG
if [ $? -ne 0 ]; then echo "fetch.mjs FAILED" >> $LOG; fi
COUNT=$($NODE -e 'try{console.log(JSON.parse(require("fs").readFileSync("tweets.json","utf8")).count)}catch(e){console.log("ERR")}')
echo "fetched: $COUNT tweets" >> $LOG

# 2) Summarize → write digest.html (Anthropic API; needs ANTHROPIC_API_KEY in .env)
rm -f digest.html
$NODE summarize.mjs >> $LOG 2>&1

# 3) Send to Telegram
$NODE telegram.mjs >> $LOG 2>&1

echo "===== $(date) DONE =====" >> $LOG
