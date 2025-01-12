#!/bin/bash

OPTIONS=$@

if [[ $NO_COMMIT ]]; then
    COMMIT=""
else
    COMMIT="--commit"
fi

if [[ -z $ORG_NUMMER ]]; then
    ORG_NUMMER=$(cat config.json | jq -r .orgnummer)
fi

if [[ -z $ORG_NUMMER ]]; then
    FILE_STORE="./kontoutdrag"
else
    FILE_STORE="./kontoutdrag-$ORG_NUMMER"
fi

if [[ $EXIT_NOW ]]; then
    echo COMMIT: $COMMIT
    echo ORG_NUMMER: $ORG_NUMMER
    echo FILE_STORE: $FILE_STORE
    echo OPTIONS: $OPTIONS

    echo "All options processed, exit"
    exit 0
fi



import_kontoutdrag () {

echo "import_kontoutdrag: " $@

# bokf_trans_165590710314, Kontohändelser
BASENAME=$1

# skv, seb
FORMAT=$2

#1630, 1930
ACCOUNT=$3



FILES=$(find ~/Downloads/ -name "$BASENAME*")

echo "import_kontoutdrag, FILES: $FILES"

mkdir -p $FILE_STORE

IFS=$'\n'

for FILE in $FILES
do
    #echo Move file: $FILE

    # extract the last transaction and use the date as filename

    # skv and seb transaction files have reverse sortorder, so pick first and last
    DATELINE1=$(tail -2 $FILE | head -1)
    DATELINE2=$(head -2 $FILE | tail -1)

    #echo "Datelines"
    #echo $DATELINE1
    #echo $DATELINE2

    #echo -e "$DATELINE1\n$DATELINE2" | awk -F[,\;] '{print $1}' | sort | tail -1

    # extract date, which is first column, and sort and pick last date
    DATE=$(echo -e "$DATELINE1\n$DATELINE2" | awk -F[,\;] '{print $1}' | sort | tail -1)

    echo "---------------"
    echo "DATE: $DATE"
    echo "---------------"

    #echo "DATE: $DATE"
    DST="$FILE_STORE/$BASENAME.$DATE.csv"
    echo "MOVE: $FILE to $DST"
    cp $FILE ./archive/download
    if [[ $NO_COMMIT ]]; then
	echo "NO_COMMIT, mv $FILE" "$DST"
    else
	mv "$FILE" "$DST"
    fi
    echo "convert $FORMAT to json and merge transactions"
    JSON="$FILE_STORE/skv.$DATE.json"

    # step 1, convert transactions from CSV to json
    echo CONVERT TO JSON COMMAND: ./ownbox.js $OPTIONS $FORMAT "$DST" "$JSON"
    ./ownbox.js $OPTIONS $FORMAT "$DST" "$JSON"

    # step 1, merge transactions with existing, e.g, add all new transactions not present
    echo MERGE TRANSACTIONS COMMAND:  ./ownbox.js $OPTIONS --no-autobook --no-import-verifications $COMMIT mergetrans "$JSON" $ACCOUNT
    ./ownbox.js $OPTIONS --no-autobook --no-import-verifications $COMMIT mergetrans "$JSON" $ACCOUNT

done


}

echo "Import kontoutdrag från skatteverket"
import_kontoutdrag bokf_trans_165590710314 skv 1630
echo "Import kontoutdrag från SEB"
import_kontoutdrag Kontohändelser seb 1930

exit 0

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
    DST="$FILE_STORE/$BASENAME.$DATE.csv"
    echo "MOVE: $FILE to $DST"
    cp $FILE ./archive/download
    mv "$FILE" "$DST"
    echo "convert SKV to json and merge transactions"
    JSON="$FILE_STORE/skv.$DATE.json"
    echo CONVERT TO JSON COMMAND: ./ownbox.js $OPTIONS skv "$DST" "$JSON"
    ./ownbox.js $@ skv "$DST" "$JSON"
    echo MERGE TRANSACTIONS COMMAND:  ./ownbox.js $OPTIONS --no-autobook --no-import-verifications $COMMIT mergetrans "$JSON" "1630"
    ./ownbox.js $@ --no-autobook --no-import-verifications $COMMIT mergetrans "$JSON" "1630"
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
    cp $FILE ./archive/download
    mv "$FILE" "$DST"
    echo "convert to json"
    JSON="seb.$DATE.json"
    ./ownbox.js seb $@ "$DST" "$JSON"
    echo ./ownbox.js $OPTIONS --no-autobook --no-import-verifications $COMMIT mergetrans "$JSON" "1930"
    ./ownbox.js $@ --no-autobook --no-import-verifications $COMMIT mergetrans "$JSON" "1930"
done
