#!/bin/bash

#mv ~/Download/*
# mv ~/Downloads/bokf_trans_165590710314* .
# mv ~/Downloads/Kontohändelser* .

BASENAME=bokf_trans_165590710314

echo "-------- DO SKVFILES -------------"

SKVFILES=$(find ~/Downloads/ -name "$BASENAME*")

#echo "SKV files: $SKVFILES"

IFS=$'\n'

for FILE in $SKVFILES
do
    #echo Move file: $FILE
    DATELINE=$(tail -2 $FILE | head -1)
    #echo TO: $(basename $FILE)
    echo "DATELINE $DATELINE"
    DATE=$(echo $DATELINE | awk -F\; '{print $1}')
    #echo "DATE: $DATE"
    DST="$BASENAME.$DATE.csv"
    echo "MOVE: $FILE to $DST"
    mv "$FILE" "$DST"
    echo "convert to json and merge transactions"
    JSON="skv.$DATE.json"
    ./ownbox.js skv "$DST" "$JSON"
    ./ownbox.js --no-autobook --no-import-verifications --commit mergetrans "$JSON" "1630"
done


#cp Kontohändelser* ~/Download

BASENAME=Kontohändelser
#BASENAME=download

echo "-------- DO SEBFILES -------------"

SEBFILES=$(find ~/Downloads/ -name "$BASENAME*")

#echo "SKV files: $SKVFILES"

for FILE in $SEBFILES
do
    echo Move file: $FILE
    DATELINE=$(head -2 $FILE | tail -1)
    #echo TO: $(basename $FILE)
    #echo "DATELINE $DATELINE"
    DATE=$(echo $DATELINE | awk -F, '{print $1}')
    #echo "DATE: $DATE"
    DST="$BASENAME.$DATE.csv"
    echo "MOVE: $FILE to $DST"
    mv "$FILE" "$DST"
    echo "convert to json"
    JSON="seb.$DATE.json"
    ./ownbox.js seb "$DST" "$JSON"
    ./ownbox.js --no-autobook --no-import-verifications --commit mergetrans "$JSON" "1930"
done
