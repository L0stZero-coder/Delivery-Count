# Delivery Count

A shared delivery log for a local network. Import an Excel workbook, enter the arrival date and the total boxes, then search delivery history by any combination of product name, model and colour. History combines matching product names, models and colours within each delivery, listing distinct box numbers and barcodes with the summed quantity. The bottom row shows the quantity across the matching lines.

## Run on the host PC

Requires Python 3.10 or newer. From the repository folder in PowerShell:

```powershell
python -m pip install -r requirements.txt
python server.py
```

Open http://localhost:8765 on the host PC. On another device on the same Wi-Fi, open http://HOST-IP:8765 using the host PC's Wi-Fi IPv4 address from `ipconfig`. Keep the host PC and server running. If Windows Firewall prompts, allow Python on the private network. This app has no sign-in. Keep it on a trusted local network.

## Import format

Place Product Name, Model (or Product Model), QTY and Colour in the first non-empty row of the worksheet named Sheet 1 or Sheet1. Column order and capitalisation can vary. Each item needs a name, model, colour and positive whole-number quantity. The app accepts .xlsx, .xls, .xl and .ods workbooks up to 10 MB and 50,000 rows.

A .xl file must contain an Excel workbook in either .xlsx or .xls format.

Matching product name, model and colour combinations are grouped across capitalisation and spacing variants. Barcode and Box Number are stored with each delivery line. Vertically merged box numbers apply to every row in the merge. Other named columns are displayed in history, excluding Product Image and W Price. Repeated lines are added together when their product, box number, barcode and other imported fields match. Each saved upload records a separate delivery, including when two deliveries share an arrival date. The box count belongs to the delivery as a whole.

Data is shared across devices and stored in the host's ignored `data` directory. To back it up, stop the server and copy that directory.
