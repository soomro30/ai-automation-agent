/**
 * Email notification service for sending agent summary reports
 */

import nodemailer from 'nodemailer';

// IMKAN SMTP Configuration
const SMTP_CONFIG = {
  host: 'smtp.office365.com',
  port: 587,
  secure: false, // Use TLS
  auth: {
    user: 'adibc.notifications@imkan.ae',
    pass: 'dyjnsbxgygjxtqsx',
  },
};

export interface PlotResult {
  plotNumber: string;
  rowIndex: number;
  applicationId: string | null;
  paymentCompleted: boolean;
  downloadCompleted: boolean;
  error?: string;
}

export interface EmailSummary {
  agentName: string;
  totalPlots: number; // Total plots uploaded from Excel
  totalPlotsUploaded?: number; // DEPRECATED: Use totalPlots instead (kept for backward compatibility)
  successfulPlots: number;
  failedPlots: number;
  results: PlotResult[];
  startTime?: Date;
  endTime?: Date;
}

/**
 * Send email notification with agent summary
 */
export async function sendEmailNotification(
  recipientEmail: string,
  summary: EmailSummary,
  ccEmail?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('\n📧 Preparing to send email notification...');
    console.log(`   Recipient: ${recipientEmail}`);
    if (ccEmail) {
      console.log(`   CC: ${ccEmail}`);
    }

    // Create transporter
    const transporter = nodemailer.createTransport(SMTP_CONFIG);

    // Verify connection
    console.log('   Verifying SMTP connection...');
    await transporter.verify();
    console.log('   ✓ SMTP connection verified\n');

    // Generate HTML email content
    const htmlContent = generateEmailHTML(summary);
    const textContent = generateEmailText(summary);

    // Email options
    const mailOptions = {
      from: {
        name: 'IMKAN Automation Agents',
        address: 'adibc.notifications@imkan.ae',
      },
      to: recipientEmail,
      cc: ccEmail || undefined,
      subject: `${summary.agentName} - Automation Summary Report`,
      text: textContent,
      html: htmlContent,
    };

    // Send email
    console.log('   Sending email...');
    const info = await transporter.sendMail(mailOptions);
    console.log('   ✅ Email sent successfully!');
    console.log(`   Message ID: ${info.messageId}\n`);

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('   ❌ Failed to send email:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Generate HTML email content
 */
function generateEmailHTML(summary: EmailSummary): string {
  const {
    agentName,
    totalPlots,
    results,
    startTime,
    endTime,
  } = summary;

  // Calculate statistics
  const paidPlots = results.filter(r => r.paymentCompleted).length;
  const downloadedPlots = results.filter(r => r.downloadCompleted).length;
  const notFoundPlots = results.filter(
    r => r.error?.includes('not found') || r.error?.includes("don't own any property")
  ).length;
  const otherFailedPlots = results.filter(
    r => r.error && !r.error.includes('not found') && !r.error.includes("don't own any property")
  ).length;

  // Calculate plots attempted vs skipped
  const plotsAttempted = results.length;
  const plotsSkipped = totalPlots - plotsAttempted;

  // Duration calculation
  let duration = '';
  if (startTime && endTime) {
    const durationMs = endTime.getTime() - startTime.getTime();
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    duration = `${minutes}m ${seconds}s`;
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      line-height: 1.6;
      color: #333;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background-color: white;
      border-radius: 8px;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      overflow: hidden;
    }
    .header {
      background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%);
      color: white;
      padding: 30px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }
    .header p {
      margin: 5px 0 0 0;
      opacity: 0.9;
      font-size: 14px;
    }
    .content {
      padding: 30px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 15px;
      margin: 20px 0;
    }
    .stat-card {
      background-color: #f8fafc;
      border-left: 4px solid #2563eb;
      padding: 15px;
      border-radius: 4px;
    }
    .stat-card.success {
      border-left-color: #10b981;
    }
    .stat-card.warning {
      border-left-color: #f59e0b;
    }
    .stat-card.error {
      border-left-color: #ef4444;
    }
    .stat-label {
      font-size: 12px;
      color: #64748b;
      text-transform: uppercase;
      font-weight: 600;
      margin-bottom: 5px;
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #1e293b;
    }
    .results-table {
      width: 100%;
      border-collapse: collapse;
      margin: 20px 0;
      font-size: 14px;
    }
    .results-table th {
      background-color: #f1f5f9;
      color: #475569;
      font-weight: 600;
      text-align: left;
      padding: 12px;
      border-bottom: 2px solid #cbd5e1;
    }
    .results-table td {
      padding: 12px;
      border-bottom: 1px solid #e2e8f0;
    }
    .results-table tr:hover {
      background-color: #f8fafc;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-badge.success {
      background-color: #d1fae5;
      color: #065f46;
    }
    .status-badge.pending {
      background-color: #fef3c7;
      color: #92400e;
    }
    .status-badge.failed {
      background-color: #fee2e2;
      color: #991b1b;
    }
    .footer {
      background-color: #f8fafc;
      padding: 20px 30px;
      text-align: center;
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid #e2e8f0;
    }
    .footer a {
      color: #2563eb;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${agentName}</h1>
      <p>Automation Summary Report</p>
      ${duration ? `<p>Duration: ${duration}</p>` : ''}
    </div>

    <div class="content">
      <h2 style="color: #1e293b; margin-top: 0;">📊 Overall Statistics</h2>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Uploaded (Excel)</div>
          <div class="stat-value">${totalPlots}</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Attempted</div>
          <div class="stat-value">${plotsAttempted}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">Downloads</div>
          <div class="stat-value">${downloadedPlots}</div>
        </div>
        <div class="stat-card success">
          <div class="stat-label">Payments</div>
          <div class="stat-value">${paidPlots}</div>
        </div>
        <div class="stat-card warning">
          <div class="stat-label">Not Found</div>
          <div class="stat-value">${notFoundPlots}</div>
        </div>
        <div class="stat-card ${plotsSkipped > 0 ? 'error' : ''}">
          <div class="stat-label">Skipped</div>
          <div class="stat-value">${plotsSkipped}</div>
        </div>
        <div class="stat-card error">
          <div class="stat-label">Other Failures</div>
          <div class="stat-value">${otherFailedPlots}</div>
        </div>
      </div>

      <h2 style="color: #1e293b; margin-top: 30px;">📋 Detailed Results</h2>

      <table class="results-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Plot Number</th>
            <th>Application ID</th>
            <th>Payment</th>
            <th>Download</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${results.map((result, index) => {
            const hasError = !!result.error;
            const statusBadge = result.downloadCompleted
              ? '<span class="status-badge success">✓ Success</span>'
              : hasError
              ? '<span class="status-badge failed">✗ Failed</span>'
              : '<span class="status-badge pending">⏳ Pending</span>';

            return `
              <tr>
                <td>${index + 1}</td>
                <td><strong>${result.plotNumber}</strong></td>
                <td>${result.applicationId || 'N/A'}</td>
                <td>${result.paymentCompleted ? '✅' : '❌'}</td>
                <td>${result.downloadCompleted ? '✅' : '❌'}</td>
                <td>
                  ${statusBadge}
                  ${hasError ? `<br><small style="color: #ef4444;">${result.error}</small>` : ''}
                </td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>

      ${plotsSkipped > 0 ? `
        <div style="background-color: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; border-radius: 4px; margin-top: 20px;">
          <h3 style="margin: 0 0 10px 0; color: #991b1b;">🛑 Plots Skipped (${plotsSkipped} of ${totalPlots})</h3>
          <p style="margin: 0; font-size: 14px; color: #7f1d1d;">
            ${plotsSkipped} plot(s) from the Excel file were <strong>not processed</strong>. The agent stopped before attempting these plots, likely due to insufficient balance or a critical error on the first plot.
          </p>
        </div>
      ` : ''}

      ${notFoundPlots > 0 ? `
        <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; border-radius: 4px; margin-top: 20px;">
          <h3 style="margin: 0 0 10px 0; color: #92400e;">⚠️ Plots Not Found (${notFoundPlots})</h3>
          <p style="margin: 0; font-size: 14px; color: #78350f;">
            These plots do not exist in the Dari system or you do not own them. No payments were made for these plots.
          </p>
        </div>
      ` : ''}

      ${results.filter(r => r.paymentCompleted && !r.downloadCompleted).length > 0 ? `
        <div style="background-color: #dbeafe; border-left: 4px solid #2563eb; padding: 15px; border-radius: 4px; margin-top: 20px;">
          <h3 style="margin: 0 0 10px 0; color: #1e40af;">ℹ️ Pending Downloads (${results.filter(r => r.paymentCompleted && !r.downloadCompleted).length})</h3>
          <p style="margin: 0; font-size: 14px; color: #1e40af;">
            These plots have been paid for but downloads did not complete. You can retry downloading these certificates later.
          </p>
        </div>
      ` : ''}
    </div>

    <div class="footer">
      <p><strong>IMKAN Automation Agents</strong> • Powered by SAAL.AI</p>
      <p>Generated on ${new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })} GST</p>
      <p><a href="https://adibc.imkan.ae">https://adibc.imkan.ae</a></p>
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Generate plain text email content (fallback)
 */
function generateEmailText(summary: EmailSummary): string {
  const {
    agentName,
    totalPlots,
    results,
  } = summary;

  const paidPlots = results.filter(r => r.paymentCompleted).length;
  const downloadedPlots = results.filter(r => r.downloadCompleted).length;
  const notFoundPlots = results.filter(
    r => r.error?.includes('not found') || r.error?.includes("don't own any property")
  ).length;
  const otherFailedPlots = results.filter(
    r => r.error && !r.error.includes('not found') && !r.error.includes("don't own any property")
  ).length;

  // Calculate plots attempted vs skipped
  const plotsAttempted = results.length;
  const plotsSkipped = totalPlots - plotsAttempted;

  let text = `
${agentName} - Automation Summary Report
${'='.repeat(60)}

OVERALL STATISTICS:
------------------
Total Plots Uploaded:      ${totalPlots}
Plots Attempted:           ${plotsAttempted}
Plots Skipped:             ${plotsSkipped}
Payments Completed:        ${paidPlots}
Downloads Completed:       ${downloadedPlots}
Not Found in Dari:         ${notFoundPlots}
Other Failures:            ${otherFailedPlots}

DETAILED RESULTS:
-----------------
`;

  results.forEach((result, index) => {
    text += `\n${index + 1}. Plot: ${result.plotNumber} (Row ${result.rowIndex})`;
    text += `\n   Application ID:  ${result.applicationId || 'N/A'}`;
    text += `\n   Payment:         ${result.paymentCompleted ? '✅ Completed' : '❌ Not Completed'}`;
    text += `\n   Download:        ${result.downloadCompleted ? '✅ Downloaded' : '⚠️  Pending/Failed'}`;
    if (result.error) {
      text += `\n   Error:           ${result.error}`;
    }
    text += '\n';
  });

  text += `
${'='.repeat(60)}
IMKAN Automation Agents - Powered by SAAL.AI
Generated on ${new Date().toLocaleString('en-AE', { timeZone: 'Asia/Dubai' })} GST
https://adibc.imkan.ae
  `;

  return text;
}
