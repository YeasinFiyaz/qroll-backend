const nodemailer = require('nodemailer');
require('dotenv').config();

const mailerConfigured = () => !!(process.env.EMAIL_USER && process.env.EMAIL_PASS);

let transporter;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
  }
  return transporter;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const sendLowAttendanceAlert = async (studentEmail, studentName, courseName, percentage, threshold = 75) => {
  const name = escapeHtml(studentName);
  const course = escapeHtml(courseName);
  const mailOptions = {
    from: `"QRoll Attendance System" <${process.env.EMAIL_USER}>`,
    to: studentEmail,
    subject: `⚠️ Low Attendance Alert — ${courseName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 24px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #fff; margin: 0; font-size: 28px;">QRoll</h1>
          <p style="color: rgba(255,255,255,0.85); margin: 4px 0 0 0;">Smart Attendance System</p>
        </div>
        <div style="background-color: #fff; padding: 32px; border: 1px solid #eee; border-radius: 0 0 12px 12px;">
          <h2 style="color: #c0392b;">⚠️ Low Attendance Warning</h2>
          <p style="color: #555; font-size: 15px;">Dear <b>${name}</b>,</p>
          <p style="color: #555; font-size: 15px;">
            Your attendance in <b>${course}</b> has dropped below the required threshold.
          </p>
          <div style="background-color: #fff5f5; border: 1px solid #feb2b2; border-radius: 8px; padding: 20px; margin: 24px 0; text-align: center;">
            <p style="margin: 0; color: #888; font-size: 13px;">Current Attendance</p>
            <h1 style="margin: 8px 0; color: #c0392b; font-size: 48px;">${Number(percentage) || 0}%</h1>
            <p style="margin: 0; color: #888; font-size: 13px;">Minimum required: ${threshold}%</p>
          </div>
          <p style="color: #555; font-size: 15px;">
            Please make sure to attend upcoming classes to avoid any academic consequences.
          </p>
          <div style="margin-top: 32px; padding-top: 24px; border-top: 1px solid #eee;">
            <p style="color: #aaa; font-size: 12px; margin: 0;">
              This is an automated alert from QRoll Attendance System.
            </p>
          </div>
        </div>
      </div>
    `,
  };

  await getTransporter().sendMail(mailOptions);
};

const sendPasswordReset = async (email, name, link) => {
  await getTransporter().sendMail({
    from: `"QRoll Attendance System" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: 'Reset your QRoll password',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #4f46e5, #7c3aed); padding: 24px; border-radius: 12px 12px 0 0;">
          <h1 style="color: #fff; margin: 0; font-size: 26px;">QRoll</h1>
          <p style="color: rgba(255,255,255,0.85); margin: 4px 0 0 0;">Smart Attendance System</p>
        </div>
        <div style="background: #fff; padding: 32px; border: 1px solid #eee; border-radius: 0 0 12px 12px;">
          <p style="color: #333; font-size: 15px;">Hi <b>${escapeHtml(name)}</b>,</p>
          <p style="color: #555; font-size: 15px;">We received a request to reset the password for your QRoll account. Click the button below to choose a new password. The link works for <b>30 minutes</b>.</p>
          <p style="text-align: center; margin: 28px 0;">
            <a href="${link}" style="background: #5b4bff; color: #fff; text-decoration: none; padding: 14px 26px; border-radius: 10px; font-weight: bold; display: inline-block;">Reset password</a>
          </p>
          <p style="color: #888; font-size: 13px;">If the button doesn't work, copy this link into your browser:<br><a href="${link}" style="color: #5b4bff; word-break: break-all;">${link}</a></p>
          <p style="color: #888; font-size: 13px; margin-top: 24px;">If you didn't ask for this, you can ignore this email — your password will stay the same.</p>
        </div>
      </div>
    `,
  });
};

module.exports = { sendLowAttendanceAlert, sendPasswordReset, mailerConfigured };
